import { Router } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db, clientsTable, cashFlowTable, invoicesTable, debtsTable } from "@workspace/db";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/requireAuth";

const router = Router();

router.get("/dashboard/summary", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.json({
      totalClients: 0,
      activeClients: 0,
      totalIncome: 0,
      totalExpenses: 0,
      netBalance: 0,
      pendingInvoicesCount: 0,
      pendingInvoicesTotal: 0,
      overdueDebtsCount: 0,
      overdueDebtsTotal: 0,
    });
    return;
  }

  const companyId = req.companyId;

  const [totalClientsResult] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(clientsTable)
    .where(eq(clientsTable.companyId, companyId));

  const [activeClientsResult] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(clientsTable)
    .where(and(eq(clientsTable.companyId, companyId), eq(clientsTable.status, "active")));

  const [incomeResult] = await db
    .select({ total: sql<number>`COALESCE(SUM(${cashFlowTable.amount}::numeric), 0)` })
    .from(cashFlowTable)
    .where(and(eq(cashFlowTable.companyId, companyId), eq(cashFlowTable.type, "income")));

  const [expenseResult] = await db
    .select({ total: sql<number>`COALESCE(SUM(${cashFlowTable.amount}::numeric), 0)` })
    .from(cashFlowTable)
    .where(and(eq(cashFlowTable.companyId, companyId), eq(cashFlowTable.type, "expense")));

  const [pendingInvoicesResult] = await db
    .select({
      count: sql<number>`COUNT(*)`,
      total: sql<number>`COALESCE(SUM(${invoicesTable.amount}::numeric), 0)`,
    })
    .from(invoicesTable)
    .where(and(eq(invoicesTable.companyId, companyId), eq(invoicesTable.status, "pending")));

  const overdueDebtsRows = await db
    .select({
      count: sql<number>`COUNT(*)`,
    })
    .from(debtsTable)
    .leftJoin(invoicesTable, eq(debtsTable.invoiceId, invoicesTable.id))
    .where(
      and(
        eq(debtsTable.companyId, companyId),
        eq(debtsTable.status, "open"),
        sql`(${invoicesTable.interestPaid} IS NOT TRUE)`
      )
    );

  const overdueDebtsWithAmount = await db
    .select({
      total: sql<number>`COALESCE(SUM(${invoicesTable.amount}::numeric), 0)`,
    })
    .from(debtsTable)
    .leftJoin(invoicesTable, eq(debtsTable.invoiceId, invoicesTable.id))
    .where(
      and(
        eq(debtsTable.companyId, companyId),
        eq(debtsTable.status, "open"),
        sql`(${invoicesTable.interestPaid} IS NOT TRUE)`
      )
    );

  const [totalLoanedResult] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${invoicesTable.amount}::numeric), 0)`,
    })
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.companyId, companyId),
        sql`${invoicesTable.status} IN ('pending', 'overdue')`
      )
    );

  const [todayLoanedResult] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${invoicesTable.amount}::numeric), 0)`,
    })
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.companyId, companyId),
        sql`DATE(${invoicesTable.createdAt}) = CURRENT_DATE`
      )
    );

  // Total interest due: sum of (amount * interestRate / 100) for all active invoices with interestRate > 0
  const [totalInterestDueResult] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${invoicesTable.amount}::numeric * ${invoicesTable.interestRate}::numeric / 100), 0)`,
    })
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.companyId, companyId),
        sql`${invoicesTable.status} IN ('pending', 'overdue', 'requested')`,
        sql`${invoicesTable.interestRate}::numeric > 0`,
        sql`${invoicesTable.interestPaid} IS NOT TRUE`
      )
    );

  const totalIncome = parseFloat(String(incomeResult?.total ?? 0));
  const totalExpenses = parseFloat(String(expenseResult?.total ?? 0));

  res.json({
    totalClients: Number(totalClientsResult?.count ?? 0),
    activeClients: Number(activeClientsResult?.count ?? 0),
    totalIncome,
    totalExpenses,
    netBalance: totalIncome - totalExpenses,
    pendingInvoicesCount: Number(pendingInvoicesResult?.count ?? 0),
    pendingInvoicesTotal: parseFloat(String(pendingInvoicesResult?.total ?? 0)),
    overdueDebtsCount: Number(overdueDebtsRows[0]?.count ?? 0),
    overdueDebtsTotal: parseFloat(String(overdueDebtsWithAmount[0]?.total ?? 0)),
    totalLoaned: parseFloat(String(totalLoanedResult?.total ?? 0)),
    todayLoaned: parseFloat(String(todayLoanedResult?.total ?? 0)),
    totalInterestDue: parseFloat(String(totalInterestDueResult?.total ?? 0)),
  });
});

router.get("/dashboard/cashflow-daily", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.json([]);
    return;
  }

  const companyId = req.companyId;

  const rows = await db
    .select({
      date: sql<string>`DATE(${cashFlowTable.date})::text`,
      type: cashFlowTable.type,
      total: sql<number>`COALESCE(SUM(${cashFlowTable.amount}::numeric), 0)`,
    })
    .from(cashFlowTable)
    .where(eq(cashFlowTable.companyId, companyId))
    .groupBy(sql`DATE(${cashFlowTable.date})`, cashFlowTable.type)
    .orderBy(sql`DATE(${cashFlowTable.date})`);

  const dayMap = new Map<string, { income: number; expense: number }>();
  for (const row of rows) {
    if (!dayMap.has(row.date)) dayMap.set(row.date, { income: 0, expense: 0 });
    const day = dayMap.get(row.date)!;
    if (row.type === "income") day.income = parseFloat(String(row.total));
    else day.expense = parseFloat(String(row.total));
  }

  const result = Array.from(dayMap.entries()).map(([date, { income, expense }]) => ({
    date,
    income,
    expense,
    net: income - expense,
  }));

  res.json(result);
});

export default router;
