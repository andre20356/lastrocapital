import { Router } from "express";
import { eq, desc, count } from "drizzle-orm";
import { db, companiesTable, subscriptionsTable } from "@workspace/db";
import { getAuth } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";

export const adminRouter = Router();

const EVOLUTION_SERVER_URL = () => process.env.EVOLUTION_SERVER_URL ?? "http://evolution:8080";
const EVOLUTION_API_KEY    = () => process.env.EVOLUTION_API_KEY ?? "";
const EVOLUTION_WEBHOOK_URL = () => process.env.EVOLUTION_WEBHOOK_URL ?? "";

// IDs Clerk com acesso admin (separados por vírgula no .env)
function getAdminIds(): string[] {
  return (process.env.ADMIN_CLERK_USER_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean);
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const auth = getAuth(req);
  const userId = auth?.userId;
  if (!userId || !getAdminIds().includes(userId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

// GET /api/admin/me — verifica se o usuário atual é admin
adminRouter.get("/admin/me", requireAdmin, (_req, res): void => {
  res.json({ isAdmin: true });
});

// GET /api/admin/stats — totais gerais
adminRouter.get("/admin/stats", requireAdmin, async (_req, res): Promise<void> => {
  try {
    const [{ total }] = await db.select({ total: count() }).from(companiesTable);

    const connected = await db
      .select({ total: count() })
      .from(companiesTable)
      .where(eq(companiesTable.whatsappStatus, "connected"));

    const activeSubs = await db
      .select({ total: count() })
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.status, "active"));

    res.json({
      totalSubscribers: Number(total),
      connectedWhatsapp: Number(connected[0]?.total ?? 0),
      activeSubscriptions: Number(activeSubs[0]?.total ?? 0),
    });
  } catch (e: any) {
    logger.error({ err: e }, "[Admin] GET /api/admin/stats");
    res.status(500).json({ error: "Erro interno" });
  }
});

// GET /api/admin/subscribers — lista todos os assinantes com status
adminRouter.get("/admin/subscribers", requireAdmin, async (_req, res): Promise<void> => {
  try {
    const companies = await db
      .select()
      .from(companiesTable)
      .orderBy(desc(companiesTable.createdAt));

    const subs = await db.select().from(subscriptionsTable);
    const subsByCompany = new Map(subs.map(s => [s.companyId, s]));

    // Busca status real de cada instância da Evolution em paralelo
    const rows = await Promise.all(
      companies.map(async (c) => {
        let waStatus = c.whatsappStatus ?? "disconnected";

        if (c.whatsappInstance) {
          try {
            const r = await fetch(
              `${EVOLUTION_SERVER_URL()}/instance/connectionState/${c.whatsappInstance}`,
              { headers: { apikey: EVOLUTION_API_KEY() }, signal: AbortSignal.timeout(3000) },
            );
            if (r.ok) {
              const data = await r.json() as any;
              const state = data?.instance?.state ?? data?.state;
              if (state === "open") waStatus = "connected";
              else if (state === "connecting") waStatus = "connecting";
              else waStatus = "disconnected";
            }
          } catch {
            // Evolution indisponível — usa valor do DB
          }
        }

        const sub = subsByCompany.get(c.id);
        return {
          id: c.id,
          name: c.name,
          cnpj: c.cnpj ?? null,
          plan: c.plan,
          clerkUserId: c.clerkUserId,
          whatsappInstance: c.whatsappInstance ?? null,
          whatsappStatus: waStatus,
          whatsappPhone: c.whatsappPhone ?? null,
          createdAt: c.createdAt,
          subscription: sub
            ? { status: sub.status, expiresAt: sub.expiresAt ?? null }
            : null,
        };
      }),
    );

    res.json(rows);
  } catch (e: any) {
    logger.error({ err: e }, "[Admin] GET /api/admin/subscribers");
    res.status(500).json({ error: "Erro interno" });
  }
});

// DELETE /api/admin/subscribers/:id/whatsapp — desconecta WhatsApp de um assinante
adminRouter.delete("/admin/subscribers/:id/whatsapp", requireAdmin, async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

    const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, id));
    if (!company) { res.status(404).json({ error: "Assinante não encontrado" }); return; }

    if (company.whatsappInstance) {
      const apiUrl = EVOLUTION_SERVER_URL();
      const apiKey = EVOLUTION_API_KEY();
      await fetch(`${apiUrl}/instance/logout/${company.whatsappInstance}`, {
        method: "DELETE", headers: { apikey: apiKey },
      }).catch(() => {});
      await fetch(`${apiUrl}/instance/delete/${company.whatsappInstance}`, {
        method: "DELETE", headers: { apikey: apiKey },
      }).catch(() => {});
    }

    await db.update(companiesTable)
      .set({ whatsappInstance: null, whatsappStatus: "disconnected", whatsappPhone: null })
      .where(eq(companiesTable.id, id));

    logger.info(`[Admin] WhatsApp desconectado — empresa #${id}`);
    res.json({ ok: true });
  } catch (e: any) {
    logger.error({ err: e }, "[Admin] DELETE /api/admin/subscribers/:id/whatsapp");
    res.status(500).json({ error: "Erro interno" });
  }
});
