import { Router } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db, debtsTable, clientsTable, invoicesTable } from "@workspace/db";
import {
  UpdateDebtBody,
  UpdateDebtParams,
  ListDebtsQueryParams,
} from "@workspace/api-zod";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/requireAuth";

const router = Router();

router.get("/debts", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.status(404).json({ error: "No company found for this user" });
    return;
  }

  const query = ListDebtsQueryParams.safeParse(req.query);
  const status = query.success ? query.data.status : undefined;

  let conditions: any[] = [eq(debtsTable.companyId, req.companyId)];
  if (status && status !== "all") conditions.push(eq(debtsTable.status, status));

  const rows = await db
    .select({
      debt: debtsTable,
      clientName: clientsTable.name,
      invoiceAmount: invoicesTable.amount,
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
      daysOverdue: r.daysOverdue ?? r.debt.daysOverdue,
    }))
  );
});

router.patch("/debts/:id", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.status(404).json({ error: "No company found for this user" });
    return;
  }

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

  const [clientRow] = await db.select().from(clientsTable).where(eq(clientsTable.id, debt.clientId));
  const [invoiceRow] = debt.invoiceId
    ? await db.select().from(invoicesTable).where(eq(invoicesTable.id, debt.invoiceId))
    : [null];

  res.json({
    ...debt,
    clientName: clientRow?.name ?? null,
    invoiceAmount: invoiceRow?.amount != null ? parseFloat(invoiceRow.amount) : null,
  });
});

export default router;
