import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, companiesTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { handleWhatsAppWebhook, getWhatsAppQR, type WaConfig } from "../services/whatsappCommands";

const router = Router();

function buildConfig(): WaConfig | null {
  const apiUrl  = process.env["EVOLUTION_SERVER_URL"];
  const apiKey  = process.env["EVOLUTION_API_KEY"];
  const instance = process.env["WHATSAPP_INSTANCE"];
  const adminPhone = process.env["WHATSAPP_ADMIN_PHONE"];
  if (!apiUrl || !apiKey || !instance || !adminPhone) return null;
  const companyId = process.env["WHATSAPP_COMPANY_ID"] ? parseInt(process.env["WHATSAPP_COMPANY_ID"], 10) : undefined;
  return { apiUrl, apiKey, instance, adminPhone, companyId };
}

// Webhook recebido da Evolution API (sem autenticação — validado por token interno)
router.post("/api/webhook/whatsapp", async (req, res) => {
  res.status(200).json({ ok: true });

  // instance pode vir como string ou objeto (global webhook vs por-instância)
  const rawInstance = req.body?.instance;
  const instanceName: string | undefined = typeof rawInstance === "string"
    ? rawInstance
    : typeof rawInstance === "object" && rawInstance !== null
      ? (rawInstance.instanceName ?? rawInstance.instance ?? undefined)
      : undefined;
  const event = req.body?.event as string | undefined;

  // CONNECTION_UPDATE: salva o número conectado automaticamente
  if (event === "connection.update") {
    const state = req.body?.data?.instance?.state ?? req.body?.data?.state;
    const wuid: string | undefined = req.body?.data?.instance?.wuid ?? req.body?.data?.wuid;
    if (state === "open" && wuid && instanceName) {
      const phone = wuid.replace(/@.+$/, "").replace(/[^0-9]/g, "");
      try {
        // Atualiza empresa vinculada a essa instância
        const [company] = await db.select().from(companiesTable)
          .where(eq(companiesTable.whatsappInstance, instanceName)).limit(1);
        if (company) {
          await db.update(companiesTable)
            .set({ whatsappPhone: phone, whatsappStatus: "connected" })
            .where(eq(companiesTable.id, company.id));
          logger.info(`[WA] Número detectado automaticamente: ${phone} (instância ${instanceName})`);
        }
      } catch (e: any) {
        logger.warn(`[WA] Erro ao salvar número conectado: ${e.message}`);
      }
    }
    return;
  }

  // Multi-tenant: roteia por instância
  let cfg: WaConfig | null = null;
  if (instanceName && instanceName !== process.env.WHATSAPP_INSTANCE) {
    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.whatsappInstance, instanceName))
      .limit(1);

    if (company) {
      cfg = {
        apiUrl: process.env.EVOLUTION_SERVER_URL!,
        apiKey: process.env.EVOLUTION_API_KEY!,
        instance: instanceName,
        adminPhone: company.whatsappPhone ?? process.env.WHATSAPP_ADMIN_PHONE!,
        companyId: company.id,
      };
    }
  } else {
    cfg = buildConfig();
  }

  if (!cfg) {
    logger.debug({ instanceName, event }, "[WA] instância não reconhecida — webhook ignorado");
    return;
  }

  try {
    await handleWhatsAppWebhook(cfg, req.body);
  } catch (e: any) {
    logger.error({ err: e }, "[WA] Erro no webhook");
  }
});

// QR code para conectar o WhatsApp
router.get("/api/whatsapp/qr", async (req, res) => {
  const cfg = buildConfig();
  if (!cfg) {
    res.status(503).send("<h2>WhatsApp não configurado</h2>");
    return;
  }
  try {
    const data = await getWhatsAppQR(cfg);
    const base64 = (data as any)?.base64 ?? (data as any)?.qrcode?.base64 ?? null;
    const state  = (data as any)?.state ?? null;

    if (!base64 && state === "open") {
      res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>WhatsApp QR</title>
        <meta http-equiv="refresh" content="5"></head><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>✅ WhatsApp já conectado!</h2><p>Estado: <strong>open</strong></p></body></html>`);
      return;
    }

    if (!base64) {
      res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>WhatsApp QR</title>
        <meta http-equiv="refresh" content="3"></head><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>⏳ Aguardando QR code...</h2><p>Recarregando em 3 segundos...</p>
        <pre>${JSON.stringify(data, null, 2)}</pre></body></html>`);
      return;
    }

    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>WhatsApp QR</title>
      <meta http-equiv="refresh" content="30">
      <style>body{font-family:sans-serif;text-align:center;padding:40px;background:#f0f0f0}
      img{border:8px solid white;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.2)}</style>
      </head><body>
      <h2>📱 Escaneie o QR Code com o WhatsApp</h2>
      <p>Abra o WhatsApp → <strong>Configurações → Aparelhos conectados → Conectar um aparelho</strong></p>
      <img src="${base64}" width="300" height="300" alt="QR Code WhatsApp"/>
      <p style="color:#888;margin-top:20px">Esta página atualiza automaticamente a cada 30s</p>
      </body></html>`);
  } catch (e: any) {
    res.status(500).send(`<h2>Erro</h2><pre>${e.message}</pre>`);
  }
});

export default router;
