import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db, invoicesTable, clientsTable, debtsTable, cashFlowTable, companiesTable } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  CreateInvoiceBody,
  UpdateInvoiceBody,
  GetInvoiceParams,
  UpdateInvoiceParams,
  DeleteInvoiceParams,
  ListInvoicesQueryParams,
} from "@workspace/api-zod";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { calculateInvoiceTotal, calculateInterestOnly } from "../services/invoiceCalculator";
import { checkInvoiceLimit } from "../services/planLimits";
import { sendWA } from "../services/whatsappCommands";

const router = Router();

const formatInvoice = (invoice: any, clientName?: string | null) => {
  const amount = invoice.amount != null ? parseFloat(invoice.amount) : null;
  const interestRate = invoice.interestRate != null ? parseFloat(invoice.interestRate) : null;
  const lateFee = invoice.lateFee != null ? parseFloat(invoice.lateFee) : null;

  // Para cobranças vencidas, calcula os dias de atraso automaticamente com base na data atual
  let daysLate = invoice.daysLate ?? 0;
  if (invoice.status === "overdue" && invoice.dueDate) {
    const due = new Date(invoice.dueDate + "T00:00:00Z");
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const diffDays = Math.floor((today.getTime() - due.getTime()) / (1000 * 60 * 60 * 24));
    daysLate = Math.max(0, diffDays);
  }

  const invoiceForCalc = { ...invoice, daysLate };
  const totalDue = calculateInvoiceTotal(invoiceForCalc);

  return {
    ...invoice,
    amount,
    interestRate,
    lateFee,
    daysLate,
    totalDue,
    notes: invoice.notes ?? null,
    notesUpdatedAt: invoice.notesUpdatedAt ?? null,
    clientName: clientName ?? null,
  };
};

router.get("/invoices", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.status(404).json({ error: "No company found for this user" });
    return;
  }

  try {
    const query = ListInvoicesQueryParams.safeParse(req.query);
    const status = query.success ? query.data.status : undefined;
    const clientId = query.success ? query.data.clientId : undefined;

    let conditions: any[] = [eq(invoicesTable.companyId, req.companyId)];
    if (status && status !== "all") conditions.push(eq(invoicesTable.status, status));
    if (clientId) conditions.push(eq(invoicesTable.clientId, clientId));

    const rows = await db
      .select({
        invoice: invoicesTable,
        clientName: clientsTable.name,
      })
      .from(invoicesTable)
      .leftJoin(clientsTable, eq(invoicesTable.clientId, clientsTable.id))
      .where(and(...conditions))
      .orderBy(invoicesTable.dueDate);

    res.json(rows.map((r) => formatInvoice(r.invoice, r.clientName)));
  } catch (err) {
    console.error("[invoices] GET /invoices:", err);
    res.status(500).json({ error: "Erro interno ao buscar cobranças" });
  }
});

router.post("/invoices", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.status(404).json({ error: "No company found for this user" });
    return;
  }

  try {
    const limitCheck = await checkInvoiceLimit(req.companyId);
    if (!limitCheck.allowed) {
      res.status(403).json({
        error: `Limite de cobranças atingido (${limitCheck.current}/${limitCheck.limit}). Faça upgrade do seu plano para continuar.`,
        code: "PLAN_LIMIT_REACHED",
        resource: "invoices",
        current: limitCheck.current,
        limit: limitCheck.limit,
      });
      return;
    }

    const parsed = CreateInvoiceBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const [invoice] = await db
      .insert(invoicesTable)
      .values({
        companyId: req.companyId,
        clientId: parsed.data.clientId,
        amount: parsed.data.amount != null ? String(parsed.data.amount) : null,
        dueDate: parsed.data.dueDate ? (parsed.data.dueDate as unknown as Date).toISOString().split("T")[0] : null,
        recurrence: (parsed.data.recurrence as string | undefined) ?? null,
        status: parsed.data.status ?? "pending",
        interestRate: parsed.data.interestRate != null ? String(parsed.data.interestRate) : "0",
        lateFee: parsed.data.lateFee != null ? String(parsed.data.lateFee) : "0",
        daysLate: parsed.data.daysLate ?? 0,
        notes: parsed.data.notes ? parsed.data.notes.replace(/<[^>]*>/g, "").slice(0, 1000) : null,
        notesUpdatedAt: parsed.data.notes ? new Date() : null,
      })
      .returning();

    if (invoice.status === "overdue") {
      await db.insert(debtsTable).values({
        companyId: req.companyId,
        clientId: parsed.data.clientId,
        invoiceId: invoice.id,
        status: "open",
        daysOverdue: 0,
      });
    }

    const [clientRow] = await db.select().from(clientsTable).where(eq(clientsTable.id, parsed.data.clientId));
    if (!clientRow) {
      res.status(400).json({ error: "Cliente não encontrado" });
      return;
    }
    res.status(201).json(formatInvoice(invoice, clientRow.name));
  } catch (err) {
    console.error("[invoices] POST /invoices:", err);
    res.status(500).json({ error: "Erro interno ao criar cobrança" });
  }
});

router.get("/invoices/:id", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.status(404).json({ error: "No company found for this user" });
    return;
  }

  try {
    const params = GetInvoiceParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [row] = await db
      .select({ invoice: invoicesTable, clientName: clientsTable.name })
      .from(invoicesTable)
      .leftJoin(clientsTable, eq(invoicesTable.clientId, clientsTable.id))
      .where(and(eq(invoicesTable.id, params.data.id), eq(invoicesTable.companyId, req.companyId)));

    if (!row) {
      res.status(404).json({ error: "Invoice not found" });
      return;
    }

    res.json(formatInvoice(row.invoice, row.clientName));
  } catch (err) {
    console.error("[invoices] GET /invoices/:id:", err);
    res.status(500).json({ error: "Erro interno ao buscar cobrança" });
  }
});

router.patch("/invoices/:id", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.status(404).json({ error: "No company found for this user" });
    return;
  }

  try {
    const params = UpdateInvoiceParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const parsed = UpdateInvoiceBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const [existingInvoice] = await db
      .select()
      .from(invoicesTable)
      .where(and(eq(invoicesTable.id, params.data.id), eq(invoicesTable.companyId, req.companyId)));

    if (!existingInvoice) {
      res.status(404).json({ error: "Invoice not found" });
      return;
    }

    let interestAmountPaid = 0;
    if (parsed.data.interestPaid === true && !existingInvoice.interestPaid) {
      let realDaysLate = existingInvoice.daysLate ?? 0;
      if (existingInvoice.status === "overdue" && existingInvoice.dueDate) {
        const due = new Date(existingInvoice.dueDate + "T00:00:00Z");
        const now = new Date(); now.setUTCHours(0, 0, 0, 0);
        realDaysLate = Math.max(0, Math.floor((now.getTime() - due.getTime()) / 86_400_000));
      }
      interestAmountPaid = calculateInterestOnly({ ...existingInvoice, daysLate: realDaysLate });
    }

    const updateData: any = {};
    if (parsed.data.status !== undefined) updateData.status = parsed.data.status;
    if (parsed.data.amount !== undefined) updateData.amount = String(parsed.data.amount);
    if (parsed.data.dueDate !== undefined) updateData.dueDate = (parsed.data.dueDate as unknown as Date).toISOString().split("T")[0];
    if (parsed.data.interestRate !== undefined) updateData.interestRate = String(parsed.data.interestRate);
    if (parsed.data.lateFee !== undefined) updateData.lateFee = String(parsed.data.lateFee);
    if (parsed.data.daysLate !== undefined) updateData.daysLate = parsed.data.daysLate;
    if (parsed.data.interestPaid !== undefined) updateData.interestPaid = parsed.data.interestPaid;
    if (parsed.data.notes !== undefined) {
      const sanitized = parsed.data.notes.replace(/<[^>]*>/g, "").slice(0, 1000);
      updateData.notes = sanitized;
      if (sanitized !== (existingInvoice.notes ?? "")) {
        updateData.notesUpdatedAt = new Date();
        logger.info(
          { invoiceId: params.data.id, companyId: req.companyId, userId: req.userId },
          "[invoices] nota atualizada"
        );
      }
    }

    const [invoice] = await db
      .update(invoicesTable)
      .set(updateData)
      .where(and(eq(invoicesTable.id, params.data.id), eq(invoicesTable.companyId, req.companyId)))
      .returning();

    if (!invoice) {
      res.status(404).json({ error: "Invoice not found" });
      return;
    }

    if (parsed.data.status === "overdue") {
      const existing = await db.select().from(debtsTable).where(eq(debtsTable.invoiceId, invoice.id));
      if (existing.length === 0) {
        await db.insert(debtsTable).values({
          companyId: req.companyId,
          clientId: invoice.clientId,
          invoiceId: invoice.id,
          status: "open",
          daysOverdue: 0,
        });
      }
    }

    if (parsed.data.interestPaid === true) {
      await db
        .update(debtsTable)
        .set({ status: "closed" })
        .where(and(eq(debtsTable.invoiceId, invoice.id), eq(debtsTable.status, "open")));

      const recurrence = existingInvoice.recurrence;
      const currentDueDate = existingInvoice.dueDate;
      if (recurrence && recurrence !== "none" && currentDueDate) {
        const base = new Date(currentDueDate + "T12:00:00Z");
        if (recurrence === "monthly") {
          // Preserva o dia original quando possível: setUTCMonth() sozinho estoura pro
          // mês seguinte quando o dia não existe no mês de destino (ex.: 31/05 -> 01/07).
          const day = base.getUTCDate();
          base.setUTCDate(1);
          base.setUTCMonth(base.getUTCMonth() + 1);
          const lastDayOfMonth = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
          base.setUTCDate(Math.min(day, lastDayOfMonth));
        } else if (recurrence === "weekly") {
          base.setUTCDate(base.getUTCDate() + 7);
        } else if (recurrence === "biweekly") {
          base.setUTCDate(base.getUTCDate() + 14);
        } else if (recurrence === "daily") {
          base.setUTCDate(base.getUTCDate() + 1);
        }
        const newDueDate = base.toISOString().split("T")[0];
        const today = new Date().toISOString().split("T")[0];
        const newStatus = newDueDate > today ? "current" : "overdue";
        const [advanced] = await db
          .update(invoicesTable)
          .set({ dueDate: newDueDate, status: newStatus, interestPaid: false })
          .where(eq(invoicesTable.id, invoice.id))
          .returning();
        if (advanced) {
          if (newStatus === "overdue") {
            const existing = await db.select().from(debtsTable).where(and(eq(debtsTable.invoiceId, invoice.id), eq(debtsTable.status, "open")));
            if (existing.length === 0) {
              await db.insert(debtsTable).values({
                companyId: req.companyId,
                clientId: invoice.clientId,
                invoiceId: invoice.id,
                status: "open",
                daysOverdue: 0,
              });
            }
          }
          // Registra juros/multa no cashflow antes do return (fatura recorrente avançada)
          if (interestAmountPaid > 0) {
            await db.insert(cashFlowTable).values({
              companyId: req.companyId,
              type: "income",
              amount: String(interestAmountPaid.toFixed(2)),
              description: `Juros/multa pagos — Cobrança #${invoice.id}`,
              category: "juros",
              date: new Date(),
            });
          }
          const [clientRowAdv] = await db.select().from(clientsTable).where(eq(clientsTable.id, advanced.clientId));
          res.json(formatInvoice(advanced, clientRowAdv?.name));
          return;
        }
      }

      // Fatura sem recorrência e estava vencida → muda para "Em Dia" ao pagar juros
      if (existingInvoice.status === "overdue") {
        await db.update(invoicesTable)
          .set({ status: "current" })
          .where(and(eq(invoicesTable.id, params.data.id), eq(invoicesTable.companyId, req.companyId)));
      }
    }

    if (parsed.data.interestPaid === true && interestAmountPaid > 0) {
      await db.insert(cashFlowTable).values({
        companyId: req.companyId,
        type: "income",
        amount: String(interestAmountPaid.toFixed(2)),
        description: `Juros/multa pagos — Cobrança #${invoice.id}`,
        category: "juros",
        date: new Date(),
      });
    }

    const wasNotPaid = existingInvoice.status !== "paid";
    const [clientRow] = await db.select().from(clientsTable).where(eq(clientsTable.id, invoice.clientId));
    if (parsed.data.status === "paid" && wasNotPaid) {
      const principal = existingInvoice.amount != null ? parseFloat(existingInvoice.amount) : 0;
      const clientName = clientRow?.name ?? `Cliente #${invoice.clientId}`;
      if (principal > 0) {
        await db.insert(cashFlowTable).values({
          companyId: req.companyId,
          type: "income",
          amount: String(principal.toFixed(2)),
          description: `Quitação — ${clientName} (Cobrança #${invoice.id})`,
          category: "cobranças",
          date: new Date(),
        });
      }

      // Notificar cliente via WhatsApp
      const clientPhone = clientRow?.whatsappJid ?? clientRow?.phone;
      if (clientPhone) {
        try {
          const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, req.companyId)).limit(1);
          const waInstance = company?.whatsappInstance ?? process.env["WHATSAPP_INSTANCE"];
          const waApiUrl  = process.env["EVOLUTION_SERVER_URL"];
          const waApiKey  = process.env["EVOLUTION_API_KEY"];
          const waAdmin   = company?.whatsappPhone ?? process.env["WHATSAPP_ADMIN_PHONE"] ?? "";
          if (waInstance && waApiUrl && waApiKey && company?.whatsappStatus === "connected") {
            const dueStr = invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString("pt-BR") : "";
            const valStr = `R$ ${principal.toFixed(2).replace(".", ",")}`;
            const msg = `✅ *Pagamento confirmado!*\n\nOlá, *${clientName}*!\n\nSeu pagamento foi registrado com sucesso.\n\n📋 Contrato: *#${invoice.id}*${dueStr ? `\n📅 Vencimento: ${dueStr}` : ""}\n💸 Valor: *${valStr}*\n\nObrigado! 🙏`;
            await sendWA({ apiUrl: waApiUrl, apiKey: waApiKey, instance: waInstance, adminPhone: waAdmin, companyId: req.companyId }, clientPhone, msg);
            logger.info(`[WA] Notificação de pagamento enviada para ${clientPhone} (invoice #${invoice.id})`);
          }
        } catch (e: any) {
          logger.warn(`[WA] Falha ao notificar pagamento via WA: ${e.message}`);
        }
      }
    }

    res.json(formatInvoice(invoice, clientRow?.name));
  } catch (err) {
    console.error("[invoices] PATCH /invoices/:id:", err);
    res.status(500).json({ error: "Erro interno ao atualizar cobrança" });
  }
});

router.delete("/invoices/:id", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.status(404).json({ error: "No company found for this user" });
    return;
  }

  try {
    const params = DeleteInvoiceParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [invoice] = await db
      .delete(invoicesTable)
      .where(and(eq(invoicesTable.id, params.data.id), eq(invoicesTable.companyId, req.companyId)))
      .returning();

    if (!invoice) {
      res.status(404).json({ error: "Invoice not found" });
      return;
    }

    res.sendStatus(204);
  } catch (err) {
    console.error("[invoices] DELETE /invoices/:id:", err);
    res.status(500).json({ error: "Erro interno ao deletar cobrança" });
  }
});

export default router;
