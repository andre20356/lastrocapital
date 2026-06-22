import { Router } from "express";
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

  const cfg = buildConfig();
  if (!cfg) {
    logger.warn("[WA] Variáveis de ambiente não configuradas — webhook ignorado");
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
    res.status(503).json({ error: "WhatsApp não configurado" });
    return;
  }
  try {
    const data = await getWhatsAppQR(cfg);
    res.json(data);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
