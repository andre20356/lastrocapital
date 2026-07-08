import { Router } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db, debtsTable, clientsTable, invoicesTable } from "@workspace/db";
import {
  UpdateDebtBody,
  UpdateDebtParams,
  ListDebtsQueryParams,
} from "@workspace/api-zod";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { advanceRecurrenceDueDate } from "../services/invoiceCalculator";

const router = Router();

router.get("/debts", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.status(404).json({ error: "No company found for this user" });
    return;
  }

  try {
    const query = ListDebtsQueryParams.safeParse(req.query);
    const status = query.success ? query.data.status : undefined;

    let conditions: any[] = [eq(debtsTable.companyId, req.companyId)];
    if (status && status !== "all") conditions.push(eq(debtsTable.status, status));

    const rows = await db
      .select({
        debt: debtsTable,
        clientName: clientsTable.name,
        invoiceAmount: invoicesTable.amount,
        invoiceDueDate: invoicesTable.dueDate,
        invoiceRecurrence: invoicesTable.recurrence,
        invoiceInterestRate: invoicesTable.interestRate,
        invoiceLateFee: invoicesTable.lateFee,
        invoiceNotes: invoicesTable.notes,
        invoiceNotesUpdatedAt: invoicesTable.notesUpdatedAt,
        daysOverdue: sql<number>`GREATEST(0, (CURRENT_DATE - ${invoicesTable.dueDate})::integer)`,
      })
      .from(debtsTable)
      .leftJoin(clientsTable, eq(debtsTable.clientId, clientsTable.id))
      .leftJoin(invoicesTable, eq(debtsTable.invoiceId, invoicesTable.id))
      .where(and(...conditions));

    res.json(
      rows.map((r) => ({
        ...r.debt,
        clientName: r.clientName ?? null,
        invoiceAmount: r.invoiceAmount != null ? parseFloat(r.invoiceAmount) : null,
        invoiceDueDate: r.invoiceDueDate ?? null,
        invoiceRecurrence: r.invoiceRecurrence ?? null,
        invoiceInterestRate: r.invoiceInterestRate != null ? parseFloat(r.invoiceInterestRate) : null,
        invoiceLateFee: r.invoiceLateFee != null ? parseFloat(r.invoiceLateFee) : null,
        invoiceNotes: r.invoiceNotes ?? null,
        invoiceNotesUpdatedAt: r.invoiceNotesUpdatedAt ?? null,
        daysOverdue: r.daysOverdue ?? r.debt.daysOverdue,
      }))
    );
  } catch (err) {
    console.error("[debts] GET /debts:", err);
    res.status(500).json({ error: "Erro interno ao buscar dívidas" });
  }
});

router.patch("/debts/:id", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.status(404).json({ error: "No company found for this user" });
    return;
  }

  try {
    const params = UpdateDebtParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const parsed = UpdateDebtBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const [debt] = await db
      .update(debtsTable)
      .set({ status: parsed.data.status })
      .where(and(eq(debtsTable.id, params.data.id), eq(debtsTable.companyId, req.companyId)))
      .returning();

    if (!debt) {
      res.status(404).json({ error: "Debt not found" });
      return;
    }

    // Essa rota só mexia no status da dívida, nunca na fatura — resultado real (MARA
    // BANK, 2026-07-08): 9 dívidas fechadas manualmente aqui ficaram com a fatura
    // presa em "current"/"overdue" pra sempre, então a cobrança automática (que usa
    // due_date + status da fatura, não da dívida) continuava mandando aviso de
    // atraso pra clientes que o admin já tinha marcado como quitados.
    // IMPORTANTE: fechar uma dívida aqui não significa quitação total — pode ser
    // só juros/multa pagos. Por isso marca "current" (em dia), nunca "paid".
    // "paid" só acontece pelo fluxo explícito de quitação total (bot WhatsApp/
    // Telegram, opção "1 — Quitação total"), que já seta isso separadamente.
    if (debt.invoiceId) {
      if (parsed.data.status === "closed") {
        const [inv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, debt.invoiceId));
        if (inv && inv.status !== "paid") {
          // Contrato recorrente: só marcar "current" não basta, porque a cobrança
          // automática decide por due_date (não por status) — uma fatura com
          // vencimento já passado reaparece na cobrança mesmo com status "current"
          // (achado real: contrato #23 do Michael teixeira, 2026-07-08). Avança o
          // vencimento pro próximo período, igual o bot de WhatsApp/Telegram já faz
          // quando só juros/multa são pagos.
          if (inv.recurrence && inv.recurrence !== "none" && inv.dueDate) {
            const newDueDate = advanceRecurrenceDueDate(inv.dueDate, inv.recurrence);
            const today = new Date().toISOString().split("T")[0]!;
            const newStatus = newDueDate > today ? "current" : "overdue";
            await db.update(invoicesTable)
              .set({ dueDate: newDueDate, status: newStatus, interestPaid: false })
              .where(eq(invoicesTable.id, debt.invoiceId));
            if (newStatus === "overdue") {
              const existingOpen = await db.select().from(debtsTable)
                .where(and(eq(debtsTable.invoiceId, debt.invoiceId), eq(debtsTable.status, "open")));
              if (existingOpen.length === 0) {
                await db.insert(debtsTable).values({
                  companyId: req.companyId, clientId: debt.clientId, invoiceId: debt.invoiceId,
                  status: "open", daysOverdue: 0,
                });
              }
            }
          } else {
            await db.update(invoicesTable).set({ status: "current" }).where(eq(invoicesTable.id, debt.invoiceId));
          }
        }
      } else if (parsed.data.status === "open") {
        const [inv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, debt.invoiceId));
        if (inv?.status === "paid") {
          const isOverdue = inv.dueDate != null && inv.dueDate < new Date().toISOString().split("T")[0];
          await db.update(invoicesTable)
            .set({ status: isOverdue ? "overdue" : "current" })
            .where(eq(invoicesTable.id, debt.invoiceId));
        }
      }
    }

    const [clientRow] = await db.select().from(clientsTable).where(eq(clientsTable.id, debt.clientId));
    const invoiceRows = debt.invoiceId
      ? await db.select().from(invoicesTable).where(eq(invoicesTable.id, debt.invoiceId))
      : [];
    const invoiceRow = invoiceRows[0] ?? null;

    res.json({
      ...debt,
      clientName: clientRow?.name ?? null,
      invoiceAmount: invoiceRow?.amount != null ? parseFloat(invoiceRow.amount) : null,
    });
  } catch (err) {
    console.error("[debts] PATCH /debts/:id:", err);
    res.status(500).json({ error: "Erro interno ao atualizar dívida" });
  }
});

export default router;
