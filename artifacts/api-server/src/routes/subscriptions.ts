import { Router } from "express";
import { eq, desc } from "drizzle-orm";
import { db, subscriptionsTable, companiesTable } from "@workspace/db";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { PLANOS, createCustomer, createCheckout, type PlanKey } from "../services/abacatePay";

const router = Router();

const VALID_PAID_PLANS = Object.keys(PLANOS) as PlanKey[];
const TRIAL_DURATION_DAYS = 15;
const ADMIN_USER_IDS = (process.env.ADMIN_CLERK_USER_IDS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const OWNER_SUBSCRIPTION = {
  plan: "enterprise",
  status: "active",
  provider: "none",
  expiresAt: null,
  checkoutUrl: null,
} as const;

router.get(
  "/subscriptions/me",
  requireAuth,
  async (req: AuthenticatedRequest, res): Promise<void> => {
    if (!req.companyId) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    // Dono da plataforma — sempre ativo, nunca cobra
    if (req.userId && ADMIN_USER_IDS.includes(req.userId)) {
      res.json(OWNER_SUBSCRIPTION);
      return;
    }

    const [subscription] = await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.companyId, req.companyId))
      .orderBy(desc(subscriptionsTable.createdAt))
      .limit(1);

    if (!subscription) {
      res.status(404).json({ error: "No subscription found" });
      return;
    }

    res.json(subscription);
  },
);

router.post(
  "/subscriptions/start-trial",
  requireAuth,
  async (req: AuthenticatedRequest, res): Promise<void> => {
    if (!req.companyId) {
      res.status(403).json({ error: "Company not registered" });
      return;
    }

    const [existing] = await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.companyId, req.companyId))
      .orderBy(desc(subscriptionsTable.createdAt))
      .limit(1);

    if (existing) {
      res.status(409).json({
        error: "Já existe uma assinatura para esta empresa",
        code: "SUBSCRIPTION_EXISTS",
      });
      return;
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);

    const [subscription] = await db
      .insert(subscriptionsTable)
      .values({
        companyId: req.companyId,
        plan: "free",
        status: "trial",
        provider: "none",
        startedAt: now,
        expiresAt,
      })
      .returning();

    res.status(201).json(subscription);
  },
);

router.post(
  "/subscriptions/create-checkout",
  requireAuth,
  async (req: AuthenticatedRequest, res): Promise<void> => {
    if (!req.companyId || !req.userId) {
      res.status(403).json({ error: "Company not registered" });
      return;
    }

    // Dono da plataforma — nunca cobra
    if (ADMIN_USER_IDS.includes(req.userId)) {
      res.status(409).json({ error: "Já existe uma assinatura para esta empresa", code: "SUBSCRIPTION_EXISTS" });
      return;
    }

    const { plan, phone, cnpj } = req.body as { plan?: string; phone?: string; cnpj?: string };

    if (!plan || !VALID_PAID_PLANS.includes(plan as PlanKey)) {
      res.status(400).json({ error: "Plano inválido. Use: pro ou enterprise" });
      return;
    }

    const planKey = plan as PlanKey;

    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.id, req.companyId));

    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    const taxId = company.cnpj ?? (cnpj ? cnpj.replace(/\D/g, "") : undefined);

    if (!taxId) {
      res.status(400).json({ error: "CNPJ ou CPF é obrigatório para realizar o pagamento.", code: "CNPJ_REQUIRED" });
      return;
    }

    if (!company.cnpj && taxId) {
      await db
        .update(companiesTable)
        .set({ cnpj: taxId })
        .where(eq(companiesTable.id, req.companyId));
    }

    const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost";
    const protocol = req.headers["x-forwarded-proto"] ?? "https";
    const origin = `${protocol}://${host}`;
    const returnUrl = `${origin}/planos?status=pending`;
    const completionUrl = `${origin}/planos?status=success`;

    const customerEmail = `${req.userId.slice(0, 8)}@lastrocapital.app`;
    const customer = await createCustomer({
      name: company.name,
      email: customerEmail,
      cellphone: phone,
      taxId,
    });

    const checkout = await createCheckout({
      customer,
      planKey,
      returnUrl,
      completionUrl,
      companyId: req.companyId,
    });

    const now = new Date();

    const [subscription] = await db
      .insert(subscriptionsTable)
      .values({
        companyId: req.companyId,
        plan: planKey,
        status: "pending",
        provider: "abacatepay",
        externalId: checkout.id,
        checkoutUrl: checkout.url,
        startedAt: now,
      })
      .returning();

    res.status(201).json({
      subscription,
      checkoutUrl: checkout.url,
    });
  },
);

export default router;
