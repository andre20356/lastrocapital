import { getAuth } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";
import { db, companiesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export interface AuthenticatedRequest extends Request {
  userId?: string;
  companyId?: number;
}

export const requireAuth = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const auth = getAuth(req);
  const userId = auth?.userId;

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  req.userId = userId;

  const [company] = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.clerkUserId, userId));

  if (company) {
    req.companyId = company.id;
  }

  next();
};
