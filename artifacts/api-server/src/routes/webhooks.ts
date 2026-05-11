import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { db, subscriptionsTable } from "@workspace/db";
import crypto from "node:crypto";

const router = Router();

function verifySignature(req: Request): boolean {
  const secret = process.env.ABACATEPAY_WEBHOOK_SECRET;
  if (!secret) return true;

  const signature = (req.headers["x-abacatepay-signature"] as string) ?? "";
  const payload = JSON.stringify(req.body);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

router.post("/webhooks/abacatepay", async (req, res): Promise<void> => {
  if (!verifySignature(req)) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const { event, data } = req.body as {
    event?: string;
    data?: {
      pixQrCode?: { id?: string };
      billing?: { id?: string; externalId?: string; expiresAt?: string };
      subscription?: { id?: string; expiresAt?: string; nextBillingAt?: string };
    };
  };

  if (!event) {
    res.status(400).json({ error: "Missing event" });
    return;
  }

  const externalId =
    data?.pixQrCode?.id ??
    data?.billing?.id ??
    data?.subscription?.id ??
    null;

  if (!externalId) {
    req.log.warn({ event }, "AbacatePay webhook: no id in payload, ignoring");
    res.status(200).json({ received: true, note: "no subscription id" });
    return;
  }

  const [existing] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.externalId, externalId))
    .limit(1);

  if (!existing) {
    req.log.warn({ event, externalId }, "AbacatePay webhook: subscription not found");
    res.status(200).json({ received: true, note: "subscription not found" });
    return;
  }

  let newStatus: string | null = null;
  let expiresAt: Date | null = null;

  switch (event) {
    case "subscription.completed":
    case "subscription.renewed":
    case "billing.paid":
    case "subscription.paid":
    case "subscription.active": {
      newStatus = "active";
      const rawExpiry =
        data?.subscription?.nextBillingAt ??
        data?.subscription?.expiresAt ??
        data?.billing?.expiresAt;
      expiresAt = rawExpiry
        ? new Date(rawExpiry)
        : new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
      break;
    }
    case "subscription.payment_failed":
    case "payment.failed":
    case "billing.expired": {
      newStatus = "past_due";
      break;
    }
    case "subscription.cancelled":
    case "subscription.canceled":
    case "billing.refunded": {
      newStatus = "canceled";
      break;
    }
    default:
      req.log.info({ event }, "AbacatePay webhook: unhandled event, ignoring");
      res.status(200).json({ received: true, note: `unhandled event: ${event}` });
      return;
  }

  if (newStatus) {
    await db
      .update(subscriptionsTable)
      .set({
        status: newStatus,
        ...(expiresAt ? { expiresAt } : {}),
        updatedAt: new Date(),
      })
      .where(eq(subscriptionsTable.externalId, externalId));
  }

  req.log.info({ event, externalId, newStatus }, "AbacatePay webhook processed");
  res.status(200).json({ received: true });
});

export default router;
