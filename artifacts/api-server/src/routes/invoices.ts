import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db, invoicesTable, clientsTable, debtsTable, cashFlowTable } from "@workspace/db";
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

const router = Router();

const formatInvoice = (invoice: any, clientName?: string | null) => {
  const amount = invoice.amount != null ? parseFloat(invoice.amount) : null;
  const interestRate = invoice.interestRate != null ? parseFloat(invoice.interestRate) : null;
  const lateFee = invoice.lateFee != null ? parseFloat(invoice.lateFee) : null;
  const daysLate = invoice.daysLate ?? 0;
  const totalDue = calculateInvoiceTotal(invoice);
  return {
    ...invoice,
    amount,
    interestRate,
    lateFee,
    daysLate,
    totalDue,
    clientName: clientName ?? null,
  };
};

router.get("/invoices", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.status(404).json({ error: "No company found for this user" });
    return;
  }

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
    .orderBy(invoicesTable.createdAt);

  res.json(rows.map((r) => formatInvoice(r.invoice, r.clientName)));
});

router.post("/invoices", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.status(404).json({ error: "No company found for this user" });
    return;
  }

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
  res.status(201).json(formatInvoice(invoice, clientRow?.name));
});

router.get("/invoices/:id", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.status(404).json({ error: "No company found for this user" });
    return;
  }

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
});

router.patch("/invoices/:id", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.status(404).json({ error: "No company found for this user" });
    return;
  }

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

  // Fetch the current invoice before updating (needed for cashflow and interest calculations)
  const [existingInvoice] = await db
    .select()
    .from(invoicesTable)
    .where(and(eq(invoicesTable.id, params.data.id), eq(invoicesTable.companyId, req.companyId)));

  // If paying interest, calculate the interest amount
  let interestAmountPaid = 0;
  if (parsed.data.interestPaid === true && existingInvoice && !existingInvoice.interestPaid) {
    interestAmountPaid = calculateInterestOnly(existingInvoice);
  }

  const updateData: any = {};
  if (parsed.data.status !== undefined) updateData.status = parsed.data.status;
  if (parsed.data.amount !== undefined) updateData.amount = String(parsed.data.amount);
  if (parsed.data.dueDate !== undefined) updateData.dueDate = parsed.data.dueDate;
  if (parsed.data.interestRate !== undefined) updateData.interestRate = String(parsed.data.interestRate);
  if (parsed.data.lateFee !== undefined) updateData.lateFee = String(parsed.data.lateFee);
  if (parsed.data.daysLate !== undefined) updateData.daysLate = parsed.data.daysLate;
  if (parsed.data.interestPaid !== undefined) updateData.interestPaid = parsed.data.interestPaid;

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

  // When interest is paid, close the associated debt (client is no longer in arrears)
  if (parsed.data.interestPaid === true) {
    await db
      .update(debtsTable)
      .set({ status: "closed" })
      .where(and(eq(debtsTable.invoiceId, invoice.id), eq(debtsTable.status, "open")));
  }

  // Record interest payment as a cashflow income entry
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

  // When invoice is marked as paid (quitação), record the principal as cashflow income
  const wasNotPaid = existingInvoice && existingInvoice.status !== "paid";
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
  }

  res.json(formatInvoice(invoice, clientRow?.name));
});

router.delete("/invoices/:id", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.status(404).json({ error: "No company found for this user" });
    return;
  }

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
});

export default router;
