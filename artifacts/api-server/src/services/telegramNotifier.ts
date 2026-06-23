import { db, invoicesTable, clientsTable, companiesTable } from "@workspace/db";
import { eq, and, ne, isNotNull } from "drizzle-orm";
import { logger } from "../lib/logger";
import { sendWA, type WaConfig } from "./whatsappCommands";

// Notificação para o admin do SaaS (env vars)
const ADMIN_TOKEN   = process.env.TELEGRAM_BOT_TOKEN ?? "";
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID ?? "";


async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
  } catch (e: any) {
    logger.warn(`[Telegram] Falha ao enviar para chat ${chatId}: ${e.message}`);
  }
}

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const TARGETS = [
  { days: 7, label: "7 dias", icon: "🟢" },
  { days: 3, label: "3 dias", icon: "🟡" },
  { days: 1, label: "1 dia",  icon: "🟠" },
  { days: 0, label: "HOJE",   icon: "🔴" },
];

// Roda diariamente — notifica admin global + cada empresa com telegram configurado
export async function checkDueDateNotifications(): Promise<void> {
  // Busca todas as empresas com telegram configurado
  const companies = await db
    .select({
      id:               companiesTable.id,
      name:             companiesTable.name,
      telegramBotToken: companiesTable.telegramBotToken,
      telegramChatId:   companiesTable.telegramChatId,
    })
    .from(companiesTable);

  for (const { days, label, icon } of TARGETS) {
    const targetDate = addDays(days);

    const rows = await db
      .select({
        invoiceId:           invoicesTable.id,
        amount:              invoicesTable.amount,
        dueDate:             invoicesTable.dueDate,
        companyId:           invoicesTable.companyId,
        clientName:          clientsTable.name,
        clientPhone:         clientsTable.phone,
        clientTelegramChatId: clientsTable.telegramChatId,
        companyName:         companiesTable.name,
        companyBotToken:     companiesTable.telegramBotToken,
      })
      .from(invoicesTable)
      .leftJoin(clientsTable,   eq(invoicesTable.clientId,  clientsTable.id))
      .leftJoin(companiesTable, eq(invoicesTable.companyId, companiesTable.id))
      .where(
        and(
          eq(invoicesTable.dueDate, targetDate),
          ne(invoicesTable.status, "paid"),
        ),
      );

    if (rows.length === 0) continue;

    // 1. Notifica admin global (env vars) com todas as faturas
    if (ADMIN_TOKEN && ADMIN_CHAT_ID) {
      const lines = rows.map((r) => {
        const valor = r.amount ? `R$ ${parseFloat(r.amount).toFixed(2).replace(".", ",")}` : "—";
        const fone  = r.clientPhone ? ` | ${r.clientPhone}` : "";
        return `  • <b>${r.clientName ?? "—"}</b>${fone} — ${valor} (${r.companyName ?? "?"})`;
      });
      const msg = `${icon} <b>Vencimentos em ${label}</b> (${targetDate})\n` + lines.join("\n");
      await sendTelegram(ADMIN_TOKEN, ADMIN_CHAT_ID, msg);
      logger.info(`[Telegram] Admin notificado: ${rows.length} fatura(s) em ${label}`);
    }

    // 2. Notifica cada empresa individualmente com suas próprias faturas
    for (const company of companies) {
      if (!company.telegramBotToken || !company.telegramChatId) continue;

      const companyRows = rows.filter((r) => r.companyId === company.id);
      if (companyRows.length === 0) continue;

      const lines = companyRows.map((r) => {
        const valor = r.amount ? `R$ ${parseFloat(r.amount).toFixed(2).replace(".", ",")}` : "—";
        const fone  = r.clientPhone ? ` | ${r.clientPhone}` : "";
        return `  • <b>${r.clientName ?? "—"}</b>${fone} — ${valor}`;
      });

      const msg =
        `${icon} <b>Vencimentos em ${label}</b> (${targetDate})\n` +
        lines.join("\n") + "\n\n" +
        `📋 <i>Acesse o Lastro Capital para gerenciar</i>`;

      await sendTelegram(company.telegramBotToken, company.telegramChatId, msg);
      logger.info(`[Telegram] Empresa "${company.name}" notificada: ${companyRows.length} fatura(s) em ${label}`);
    }

    // 3. Notifica clientes diretamente (quem vinculou o Telegram)
    const clientRows = rows.filter((r) => r.clientTelegramChatId && r.companyBotToken);
    for (const r of clientRows) {
      const valor  = r.amount ? `R$ ${parseFloat(r.amount).toFixed(2).replace(".", ",")}` : "—";
      const dueFmt = r.dueDate
        ? new Date(r.dueDate + "T00:00:00Z").toLocaleDateString("pt-BR", { timeZone: "UTC" })
        : targetDate;

      const venceTexto = days === 0
        ? `vence <b>hoje</b> (${dueFmt})`
        : days === 1
          ? `vence <b>amanhã</b> (${dueFmt})`
          : `vence em <b>${label}</b> (${dueFmt})`;

      const clientMsg =
        `${icon} Olá, <b>${r.clientName ?? "cliente"}</b>!\n\n` +
        `Seu pagamento de <b>${valor}</b> ${venceTexto}.\n\n` +
        `Qualquer dúvida, entre em contato conosco. 😊`;

      await sendTelegram(r.companyBotToken!, r.clientTelegramChatId!, clientMsg);
      logger.info(`[Telegram] Cliente "${r.clientName}" notificado diretamente (vence em ${label})`);
    }

    // 4. Notifica clientes via WhatsApp (quem tem telefone cadastrado)
    const waApiUrl   = process.env["EVOLUTION_SERVER_URL"];
    const waApiKey   = process.env["EVOLUTION_API_KEY"];
    const waInstance = process.env["WHATSAPP_INSTANCE"];
    const waAdmin    = process.env["WHATSAPP_ADMIN_PHONE"];
    const waCfg = waApiUrl && waApiKey && waInstance && waAdmin
      ? { apiUrl: waApiUrl, apiKey: waApiKey, instance: waInstance, adminPhone: waAdmin,
          companyId: process.env["WHATSAPP_COMPANY_ID"] ? parseInt(process.env["WHATSAPP_COMPANY_ID"], 10) : undefined }
      : null;
    if (waCfg) {
      const waClientRows = rows.filter((r) => r.clientPhone);
      for (const r of waClientRows) {
        const valor  = r.amount ? `R$ ${parseFloat(r.amount).toFixed(2).replace(".", ",")}` : "—";
        const dueFmt = r.dueDate
          ? new Date(r.dueDate + "T00:00:00Z").toLocaleDateString("pt-BR", { timeZone: "UTC" })
          : targetDate;

        const venceTexto = days === 0
          ? `vence *hoje* (${dueFmt})`
          : days === 1
            ? `vence *amanhã* (${dueFmt})`
            : `vence em *${label}* (${dueFmt})`;

        const clientMsg =
          `${icon} Olá, *${r.clientName ?? "cliente"}*!\n\n` +
          `Seu pagamento de *${valor}* ${venceTexto}.\n\n` +
          `Qualquer dúvida, entre em contato conosco. 😊`;

        const clientPhone = r.clientPhone!.replace(/\D/g, "");
        await sendWA(waCfg, clientPhone, clientMsg).catch((e: any) =>
          logger.warn(`[WA] Falha ao notificar cliente ${r.clientName}: ${e.message}`),
        );
        logger.info(`[WA] Cliente "${r.clientName}" notificado via WhatsApp (vence em ${label})`);
      }
    }
  }
}
