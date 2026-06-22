import app from "./app";
import { logger } from "./lib/logger";
import { checkDueDateNotifications } from "./services/telegramNotifier";
import { startTelegramCommandPolling } from "./services/telegramCommands";
import { initWhatsAppInstance } from "./services/whatsappCommands";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Cron diário de notificações de vencimento via Telegram (08:00 BRT)
  const scheduleDaily = () => {
    const now   = new Date();
    const next  = new Date();
    next.setHours(8, 0, 0, 0);          // 08:00 BRT (UTC-3 → 11:00 UTC)
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next.getTime() - now.getTime();
    setTimeout(() => {
      checkDueDateNotifications().catch((e) =>
        logger.error({ err: e }, "[Telegram] Erro no cron de vencimentos"),
      );
      setInterval(
        () =>
          checkDueDateNotifications().catch((e) =>
            logger.error({ err: e }, "[Telegram] Erro no cron de vencimentos"),
          ),
        24 * 60 * 60 * 1000,
      );
    }, delay);
    logger.info(`[Telegram] Cron agendado — próxima execução em ${Math.round(delay / 60000)} min`);
  };

  scheduleDaily();
  startTelegramCommandPolling();

  // WhatsApp via Evolution API (opcional — só inicia se EVOLUTION_SERVER_URL estiver configurado)
  const waUrl    = process.env["EVOLUTION_SERVER_URL"];
  const waKey    = process.env["EVOLUTION_API_KEY"];
  const waInst   = process.env["WHATSAPP_INSTANCE"];
  const waAdmin  = process.env["WHATSAPP_ADMIN_PHONE"];
  const waWebhook = process.env["EVOLUTION_WEBHOOK_URL"] ?? `http://api:8080/api/webhook/whatsapp`;
  if (waUrl && waKey && waInst && waAdmin) {
    const companyIdRaw = process.env["WHATSAPP_COMPANY_ID"];
    initWhatsAppInstance(
      { apiUrl: waUrl, apiKey: waKey, instance: waInst, adminPhone: waAdmin, companyId: companyIdRaw ? parseInt(companyIdRaw, 10) : undefined },
      waWebhook,
    ).catch((e) => logger.warn({ err: e }, "[WA] Falha ao inicializar instância"));
  } else {
    logger.info("[WA] EVOLUTION_SERVER_URL/WHATSAPP_INSTANCE não configurados — bot WhatsApp desabilitado");
  }
});
