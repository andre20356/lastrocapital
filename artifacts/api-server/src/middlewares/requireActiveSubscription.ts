import type { Response, NextFunction } from "express";
import { eq, desc } from "drizzle-orm";
import { db, subscriptionsTable } from "@workspace/db";
import type { AuthenticatedRequest } from "./requireAuth";

const ADMIN_USER_IDS = (process.env.ADMIN_CLERK_USER_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const requireActiveSubscription = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  if (!req.companyId) {
    res.status(403).json({ error: "Company not registered" });
    return;
  }

  // Administradores têm acesso ilimitado sem assinatura
  if (req.userId && ADMIN_USER_IDS.includes(req.userId)) {
    next();
    return;
  }

  const [subscription] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.companyId, req.companyId))
    .orderBy(desc(subscriptionsTable.createdAt))
    .limit(1);

  if (!subscription) {
    res.status(402).json({
      error: "Assinatura necessária",
      code: "SUBSCRIPTION_REQUIRED",
      redirectTo: "/planos",
    });
    return;
  }

  if (subscription.status === "active") {
    next();
    return;
  }

  if (subscription.status === "trial") {
    const now = new Date();
    if (subscription.expiresAt && subscription.expiresAt > now) {
      next();
      return;
    }
    res.status(402).json({
      error: "Período de avaliação expirado",
      code: "TRIAL_EXPIRED",
      redirectTo: "/planos",
    });
    return;
  }

  res.status(402).json({
    error: "Assinatura necessária",
    code: "SUBSCRIPTION_REQUIRED",
    redirectTo: "/planos",
  });
};
