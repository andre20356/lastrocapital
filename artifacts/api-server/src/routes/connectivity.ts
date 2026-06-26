import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, companiesTable } from "@workspace/db";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { logger } from "../lib/logger";

export const connectivityRouter = Router();

const EVOLUTION_SERVER_URL = () => process.env.EVOLUTION_SERVER_URL ?? "http://evolution:8080";
const EVOLUTION_API_KEY    = () => process.env.EVOLUTION_API_KEY ?? "";
const EVOLUTION_WEBHOOK_URL = () => process.env.EVOLUTION_WEBHOOK_URL ?? "";

async function fetchEvolutionInstance(instance: string): Promise<any | null> {
  try {
    const res = await fetch(`${EVOLUTION_SERVER_URL()}/instance/fetchInstances`, {
      headers: { apikey: EVOLUTION_API_KEY() },
    });
    if (!res.ok) return null;
    const data = await res.json() as any[];
    if (!Array.isArray(data)) return null;
    return data.find((i: any) => (i.name ?? i.instance?.instanceName) === instance) ?? null;
  } catch {
    return null;
  }
}

// GET /connectivity — status WA + Telegram da empresa logada
connectivityRouter.get("/connectivity", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  try {
    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.clerkUserId, req.userId!))
      .limit(1);

    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    // WhatsApp status
    let waStatus = company.whatsappStatus ?? "disconnected";
    let waPhone: string | null = null;
    let waProfileName: string | null = null;

    if (company.whatsappInstance) {
      try {
        const statusRes = await fetch(
          `${EVOLUTION_SERVER_URL()}/instance/connectionState/${company.whatsappInstance}`,
          { headers: { apikey: EVOLUTION_API_KEY() } },
        );
        if (statusRes.ok) {
          const statusData = await statusRes.json() as any;
          const connectionStatus = statusData?.instance?.state ?? statusData?.state ?? statusData?.connectionStatus;
          if (connectionStatus === "open") {
            waStatus = "connected";
            waPhone = statusData?.instance?.wuid ?? statusData?.wuid ?? null;
            waProfileName = statusData?.instance?.profileName ?? statusData?.profileName ?? null;
            // Atualiza DB se mudou
            if (company.whatsappStatus !== "connected") {
              await db.update(companiesTable)
                .set({ whatsappStatus: "connected" })
                .where(eq(companiesTable.id, company.id));
            }
          }
        }
      } catch (e: any) {
        logger.warn(`[Connectivity] Erro ao verificar status WA: ${e.message}`);
      }
    }

    // Telegram status
    let telegramStatus = "disconnected";
    let telegramBotUsername: string | null = null;

    if (company.telegramBotToken) {
      try {
        const tRes = await fetch(`https://api.telegram.org/bot${company.telegramBotToken}/getMe`);
        const tData = await tRes.json() as { ok: boolean; result?: { username?: string } };
        if (tData.ok && tData.result?.username) {
          telegramStatus = "connected";
          telegramBotUsername = tData.result.username;
        }
      } catch {
        // ignore
      }
    }

    res.json({
      whatsapp: {
        status: waStatus,
        phone: waPhone,
        profileName: waProfileName,
        instance: company.whatsappInstance ?? null,
      },
      telegram: {
        status: telegramStatus,
        botUsername: telegramBotUsername,
        chatId: company.telegramChatId ?? null,
      },
    });
  } catch (e: any) {
    logger.error({ err: e }, "[Connectivity] GET /connectivity");
    res.status(500).json({ error: "Erro interno" });
  }
});

// POST /connectivity/whatsapp/connect
connectivityRouter.post("/connectivity/whatsapp/connect", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  try {
    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.clerkUserId, req.userId!))
      .limit(1);

    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    const instanceName = `lc_${company.id}`;
    const apiUrl = EVOLUTION_SERVER_URL();
    const apiKey = EVOLUTION_API_KEY();
    const webhookUrl = EVOLUTION_WEBHOOK_URL();

    // Verifica se instância já existe
    const existingInstance = await fetchEvolutionInstance(instanceName);

    if (!existingInstance) {
      // Cria nova instância
      const createRes = await fetch(`${apiUrl}/instance/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: apiKey },
        body: JSON.stringify({
          instanceName,
          token: apiKey,
          qrcode: true,
          integration: "WHATSAPP-BAILEYS",
          webhook: {
            url: webhookUrl,
            enabled: true,
            events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE"],
          },
        }),
      });

      if (!createRes.ok) {
        const errBody = await createRes.text().catch(() => "");
        logger.warn(`[Connectivity] Erro ao criar instância: ${createRes.status} ${errBody}`);
        res.status(502).json({ error: "Erro ao criar instância na Evolution API" });
        return;
      }
    }

    // Atualiza empresa
    await db.update(companiesTable)
      .set({ whatsappInstance: instanceName, whatsappStatus: "connecting" })
      .where(eq(companiesTable.id, company.id));

    // Busca QR code
    const connectRes = await fetch(`${apiUrl}/instance/connect/${instanceName}`, {
      headers: { apikey: apiKey },
    });

    let qrcode: string | null = null;
    if (connectRes.ok) {
      const connectData = await connectRes.json() as any;
      qrcode = connectData?.qrcode?.base64 ?? connectData?.base64 ?? connectData?.qrcode ?? null;
    }

    res.json({ qrcode, instance: instanceName });
  } catch (e: any) {
    logger.error({ err: e }, "[Connectivity] POST /connectivity/whatsapp/connect");
    res.status(500).json({ error: "Erro interno" });
  }
});

// GET /connectivity/whatsapp/qr
connectivityRouter.get("/connectivity/whatsapp/qr", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  try {
    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.clerkUserId, req.userId!))
      .limit(1);

    if (!company?.whatsappInstance) {
      res.status(404).json({ error: "Nenhuma instância configurada" });
      return;
    }

    const connectRes = await fetch(
      `${EVOLUTION_SERVER_URL()}/instance/connect/${company.whatsappInstance}`,
      { headers: { apikey: EVOLUTION_API_KEY() } },
    );

    if (!connectRes.ok) {
      res.status(502).json({ error: "Erro ao buscar QR da Evolution API" });
      return;
    }

    const data = await connectRes.json() as any;
    const qrcode = data?.qrcode?.base64 ?? data?.base64 ?? data?.qrcode ?? null;
    const status = company.whatsappStatus ?? "connecting";

    res.json({ qrcode, status });
  } catch (e: any) {
    logger.error({ err: e }, "[Connectivity] GET /connectivity/whatsapp/qr");
    res.status(500).json({ error: "Erro interno" });
  }
});

// GET /connectivity/whatsapp/status
connectivityRouter.get("/connectivity/whatsapp/status", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  try {
    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.clerkUserId, req.userId!))
      .limit(1);

    if (!company?.whatsappInstance) {
      res.json({ status: "disconnected", phone: null, profileName: null });
      return;
    }

    const statusRes = await fetch(
      `${EVOLUTION_SERVER_URL()}/instance/connectionState/${company.whatsappInstance}`,
      { headers: { apikey: EVOLUTION_API_KEY() } },
    );

    if (!statusRes.ok) {
      res.json({ status: company.whatsappStatus ?? "disconnected", phone: null, profileName: null });
      return;
    }

    const statusData = await statusRes.json() as any;
    const connectionStatus = statusData?.instance?.state ?? statusData?.state ?? statusData?.connectionStatus;

    let newStatus: string;
    let phone: string | null = null;
    let profileName: string | null = null;

    if (connectionStatus === "open") {
      newStatus = "connected";
      phone = statusData?.instance?.wuid ?? statusData?.wuid ?? null;
      profileName = statusData?.instance?.profileName ?? statusData?.profileName ?? null;
    } else if (connectionStatus === "connecting" || connectionStatus === "qrcode") {
      newStatus = "connecting";
    } else {
      newStatus = "disconnected";
    }

    // Atualiza DB se status mudou
    if (company.whatsappStatus !== newStatus) {
      await db.update(companiesTable)
        .set({ whatsappStatus: newStatus })
        .where(eq(companiesTable.id, company.id));
    }

    res.json({ status: newStatus, phone, profileName });
  } catch (e: any) {
    logger.error({ err: e }, "[Connectivity] GET /connectivity/whatsapp/status");
    res.status(500).json({ error: "Erro interno" });
  }
});

// POST /connectivity/whatsapp/pairing-code — recria instância com número e retorna código de 8 dígitos
connectivityRouter.post("/connectivity/whatsapp/pairing-code", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  try {
    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.clerkUserId, req.userId!))
      .limit(1);

    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    const { phoneNumber } = req.body as { phoneNumber?: string };
    if (!phoneNumber) {
      res.status(400).json({ error: "Número obrigatório" });
      return;
    }

    const bare = phoneNumber.replace(/\D/g, "");
    const instanceName = `lc_${company.id}`;
    const apiUrl = EVOLUTION_SERVER_URL();
    const apiKey = EVOLUTION_API_KEY();
    const webhookUrl = EVOLUTION_WEBHOOK_URL();

    // Remove instância existente para garantir código fresco
    await fetch(`${apiUrl}/instance/logout/${instanceName}`, {
      method: "DELETE", headers: { apikey: apiKey },
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 800));
    await fetch(`${apiUrl}/instance/delete/${instanceName}`, {
      method: "DELETE", headers: { apikey: apiKey },
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 800));

    // Recria com número — Evolution v2.1 retorna pairingCode ao criar com number
    const createRes = await fetch(`${apiUrl}/instance/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: apiKey },
      body: JSON.stringify({
        instanceName,
        qrcode: true,
        integration: "WHATSAPP-BAILEYS",
        number: bare,
      }),
    });
    const data = await createRes.json() as any;
    const code: string | null = data?.qrcode?.pairingCode ?? null;

    if (!code) {
      logger.warn({ data }, "[Connectivity] Pairing code não retornado pela Evolution");
      res.status(502).json({ error: "Não foi possível gerar o código. Verifique o número e tente novamente." });
      return;
    }

    // Registra webhook na nova instância
    await fetch(`${apiUrl}/webhook/set/${instanceName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: apiKey },
      body: JSON.stringify({
        webhook: {
          enabled: true,
          url: webhookUrl,
          webhook_by_events: false,
          webhook_base64: false,
          events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE"],
        },
      }),
    }).catch(() => {});

    await db.update(companiesTable)
      .set({ whatsappInstance: instanceName, whatsappStatus: "connecting" })
      .where(eq(companiesTable.id, company.id));

    logger.info(`[Connectivity] Pairing code gerado para ${instanceName}: ${code}`);
    res.json({ code });
  } catch (e: any) {
    logger.error({ err: e }, "[Connectivity] POST /connectivity/whatsapp/pairing-code");
    res.status(500).json({ error: "Erro interno" });
  }
});

// GET /connectivity/whatsapp/pairing-code — busca código atual sem recriar instância (para auto-refresh)
connectivityRouter.get("/connectivity/whatsapp/pairing-code", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  try {
    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.clerkUserId, req.userId!))
      .limit(1);

    if (!company?.whatsappInstance) {
      res.status(404).json({ error: "Nenhuma instância configurada" });
      return;
    }

    const r = await fetch(
      `${EVOLUTION_SERVER_URL()}/instance/connect/${company.whatsappInstance}`,
      { headers: { apikey: EVOLUTION_API_KEY() } },
    );
    const data = await r.json() as any;
    const code: string | null = data?.pairingCode ?? null;

    if (!code) {
      res.status(404).json({ error: "Nenhum código disponível" });
      return;
    }

    res.json({ code });
  } catch (e: any) {
    logger.error({ err: e }, "[Connectivity] GET /connectivity/whatsapp/pairing-code");
    res.status(500).json({ error: "Erro interno" });
  }
});

// DELETE /connectivity/whatsapp
connectivityRouter.delete("/connectivity/whatsapp", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  try {
    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.clerkUserId, req.userId!))
      .limit(1);

    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    if (company.whatsappInstance) {
      const apiUrl = EVOLUTION_SERVER_URL();
      const apiKey = EVOLUTION_API_KEY();

      // Logout
      try {
        await fetch(`${apiUrl}/instance/logout/${company.whatsappInstance}`, {
          method: "DELETE",
          headers: { apikey: apiKey },
        });
      } catch {
        // ignore logout errors
      }

      // Delete instance
      try {
        await fetch(`${apiUrl}/instance/delete/${company.whatsappInstance}`, {
          method: "DELETE",
          headers: { apikey: apiKey },
        });
      } catch {
        // ignore delete errors
      }
    }

    await db.update(companiesTable)
      .set({ whatsappInstance: null, whatsappStatus: "disconnected" })
      .where(eq(companiesTable.id, company.id));

    res.json({ ok: true });
  } catch (e: any) {
    logger.error({ err: e }, "[Connectivity] DELETE /connectivity/whatsapp");
    res.status(500).json({ error: "Erro interno" });
  }
});
