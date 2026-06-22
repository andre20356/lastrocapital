import { Router } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db, cashFlowTable } from "@workspace/db";
import {
  CreateCashFlowEntryBody,
  GetCashFlowEntryParams,
  DeleteCashFlowEntryParams,
  ListCashFlowQueryParams,
} from "@workspace/api-zod";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { checkCashflowLimit } from "../services/planLimits";

const router = Router();

router.get("/cashflow/by-category", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.status(404).json({ error: "No company found for this user" });
    return;
  }

  try {
    const result = await db
      .select({
        category: cashFlowTable.category,
        type: cashFlowTable.type,
        total: sql<number>`SUM(${cashFlowTable.amount}::numeric)`,
      })
      .from(cashFlowTable)
      .where(eq(cashFlowTable.companyId, req.companyId))
      .groupBy(cashFlowTable.category, cashFlowTable.type);

    res.json(result);
  } catch (err) {
    console.error("[cashflow] GET /cashflow/by-category:", err);
    res.status(500).json({ error: "Erro interno ao buscar categorias" });
  }
});

router.get("/cashflow", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.status(404).json({ error: "No company found for this user" });
    return;
  }

  try {
    const query = ListCashFlowQueryParams.safeParse(req.query);
    const type     = query.success ? query.data.type     : undefined;
    const category = query.success ? query.data.category : undefined;

    let conditions: any[] = [eq(cashFlowTable.companyId, req.companyId)];

    if (type && type !== "all") {
      conditions.push(eq(cashFlowTable.type, type));
    }
    if (category) {
      conditions.push(eq(cashFlowTable.category, category));
    }

    const entries = await db
      .select()
      .from(cashFlowTable)
      .where(and(...conditions))
      .orderBy(cashFlowTable.date);

    const mapped = entries.map((e) => ({
      ...e,
      amount: parseFloat(e.amount ?? "0"),
    }));

    res.json(mapped);
  } catch (err) {
    console.error("[cashflow] GET /cashflow:", err);
    res.status(500).json({ error: "Erro interno ao buscar lançamentos" });
  }
});

router.post("/cashflow", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.status(404).json({ error: "No company found for this user" });
    return;
  }

  try {
    const limitCheck = await checkCashflowLimit(req.companyId);
    if (!limitCheck.allowed) {
      res.status(403).json({
        error: `Limite de lançamentos atingido (${limitCheck.current}/${limitCheck.limit}). Faça upgrade do seu plano para continuar.`,
        code: "PLAN_LIMIT_REACHED",
        resource: "cashflow",
        current: limitCheck.current,
        limit: limitCheck.limit,
      });
      return;
    }

    const parsed = CreateCashFlowEntryBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const [entry] = await db
      .insert(cashFlowTable)
      .values({
        companyId: req.companyId,
        type: parsed.data.type,
        amount: String(parsed.data.amount),
        description: parsed.data.description,
        category: parsed.data.category,
        date: parsed.data.date ? new Date(parsed.data.date) : new Date(),
      })
      .returning();

    res.status(201).json({ ...entry, amount: parseFloat(entry.amount ?? "0") });
  } catch (err) {
    console.error("[cashflow] POST /cashflow:", err);
    res.status(500).json({ error: "Erro interno ao criar lançamento" });
  }
});

router.get("/cashflow/:id", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.status(404).json({ error: "No company found for this user" });
    return;
  }

  try {
    const params = GetCashFlowEntryParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [entry] = await db
      .select()
      .from(cashFlowTable)
      .where(and(eq(cashFlowTable.id, params.data.id), eq(cashFlowTable.companyId, req.companyId)));

    if (!entry) {
      res.status(404).json({ error: "Entry not found" });
      return;
    }

    res.json({ ...entry, amount: parseFloat(entry.amount ?? "0") });
  } catch (err) {
    console.error("[cashflow] GET /cashflow/:id:", err);
    res.status(500).json({ error: "Erro interno ao buscar lançamento" });
  }
});

router.delete("/cashflow/:id", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.status(404).json({ error: "No company found for this user" });
    return;
  }

  try {
    const params = DeleteCashFlowEntryParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [entry] = await db
      .delete(cashFlowTable)
      .where(and(eq(cashFlowTable.id, params.data.id), eq(cashFlowTable.companyId, req.companyId)))
      .returning();

    if (!entry) {
      res.status(404).json({ error: "Entry not found" });
      return;
    }

    res.sendStatus(204);
  } catch (err) {
    console.error("[cashflow] DELETE /cashflow/:id:", err);
    res.status(500).json({ error: "Erro interno ao deletar lançamento" });
  }
});

export default router;
