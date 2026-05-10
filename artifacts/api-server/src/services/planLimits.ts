import { eq, count, desc } from "drizzle-orm";
import { db, subscriptionsTable, clientsTable, cashFlowTable, invoicesTable } from "@workspace/db";

export interface PlanLimits {
  clients: number | null;
  cashflowEntries: number | null;
  invoices: number | null;
}

const PLAN_LIMITS: Record<string, PlanLimits> = {
  free: {
    clients: 5,
    cashflowEntries: 30,
    invoices: 15,
  },
  pro: {
    clients: 50,
    cashflowEntries: 300,
    invoices: 100,
  },
  enterprise: {
    clients: null,
    cashflowEntries: null,
    invoices: null,
  },
};

const UNLIMITED: PlanLimits = { clients: null, cashflowEntries: null, invoices: null };

export async function getCompanyPlanLimits(companyId: number): Promise<PlanLimits> {
  const [subscription] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.companyId, companyId))
    .orderBy(desc(subscriptionsTable.createdAt))
    .limit(1);

  if (!subscription) return PLAN_LIMITS["free"]!;

  return PLAN_LIMITS[subscription.plan] ?? UNLIMITED;
}

export async function checkClientLimit(companyId: number): Promise<{ allowed: boolean; current: number; limit: number | null }> {
  const limits = await getCompanyPlanLimits(companyId);
  if (limits.clients === null) return { allowed: true, current: 0, limit: null };

  const [row] = await db
    .select({ total: count() })
    .from(clientsTable)
    .where(eq(clientsTable.companyId, companyId));

  const current = row?.total ?? 0;
  return { allowed: current < limits.clients, current, limit: limits.clients };
}

export async function checkCashflowLimit(companyId: number): Promise<{ allowed: boolean; current: number; limit: number | null }> {
  const limits = await getCompanyPlanLimits(companyId);
  if (limits.cashflowEntries === null) return { allowed: true, current: 0, limit: null };

  const [row] = await db
    .select({ total: count() })
    .from(cashFlowTable)
    .where(eq(cashFlowTable.companyId, companyId));

  const current = row?.total ?? 0;
  return { allowed: current < limits.cashflowEntries, current, limit: limits.cashflowEntries };
}

export async function checkInvoiceLimit(companyId: number): Promise<{ allowed: boolean; current: number; limit: number | null }> {
  const limits = await getCompanyPlanLimits(companyId);
  if (limits.invoices === null) return { allowed: true, current: 0, limit: null };

  const [row] = await db
    .select({ total: count() })
    .from(invoicesTable)
    .where(eq(invoicesTable.companyId, companyId));

  const current = row?.total ?? 0;
  return { allowed: current < limits.invoices, current, limit: limits.invoices };
}
