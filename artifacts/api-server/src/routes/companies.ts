import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, companiesTable } from "@workspace/db";
import { RegisterCompanyBody } from "@workspace/api-zod";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/requireAuth";

const router = Router();

router.post("/companies/register", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const parsed = RegisterCompanyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const existing = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.clerkUserId, req.userId!));

  if (existing.length > 0) {
    res.status(409).json({ error: "Company already registered for this user" });
    return;
  }

  const [company] = await db
    .insert(companiesTable)
    .values({
      name: parsed.data.name,
      cnpj: parsed.data.cnpj ?? null,
      plan: parsed.data.plan ?? "free",
      clerkUserId: req.userId!,
    })
    .returning();

  res.status(201).json(company);
});

router.get("/companies/me", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const [company] = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.clerkUserId, req.userId!));

  if (!company) {
    res.status(404).json({ error: "Company not found" });
    return;
  }

  res.json(company);
});

export default router;
