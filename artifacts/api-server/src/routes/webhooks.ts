import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, subscriptionsTable } from "@workspace/db";

const router = Router();

// AbacatePay v2 envia apenas: billing.paid | payout.done | payout.failed
// Não há token/assinatura no request — segurança via URL privada
router.post("/webhooks/abacatepay", async (req, res): Promise<void> => {
  const { event, data } = req.body as {
    event?: string;
    devMode?: boolean;
    data?: {
      payment?: { amount: number; fee: number; method: string };
      billing?: { id: string; externalId: string; status: string; amount: number; url: string };
      pixQrCode?: { id: string; status: string; amount: number; kind: string };
    };
  };

  if (!event) {
    res.status(400).json({ error: "Missing event" });
    return;
  }

  req.log.info({ event }, "[AbacatePay] webhook recebido");

  if (event !== "billing.paid") {
    res.status(200).json({ received: true, note: `unhandled event: ${event}` });
    return;
  }

  // O billing ID é o externalId que salvamos ao criar o checkout
  const billingId = data?.billing?.id ?? data?.pixQrCode?.id ?? null;

  if (!billingId) {
    req.log.warn({ data }, "[AbacatePay] billing.paid sem billing.id");
    res.status(200).json({ received: true, note: "no billing id" });
    return;
  }

  const [subscription] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.externalId, billingId))
    .limit(1);

  if (!subscription) {
    req.log.warn({ billingId }, "[AbacatePay] assinatura não encontrada para billing id");
    res.status(200).json({ received: true, note: "subscription not found" });
    return;
  }

  // Pagamento único — ativa por 31 dias
  const expiresAt = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);

  await db
    .update(subscriptionsTable)
    .set({ status: "active", expiresAt, updatedAt: new Date() })
    .where(eq(subscriptionsTable.externalId, billingId));

  req.log.info({ billingId, plan: subscription.plan, expiresAt }, "[AbacatePay] assinatura ativada");
  res.status(200).json({ received: true });
});

export default router;
