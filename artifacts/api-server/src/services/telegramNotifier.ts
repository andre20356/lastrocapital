import { db, invoicesTable, clientsTable, companiesTable } from "@workspace/db";
import { eq, and, ne, isNotNull } from "drizzle-orm";
import { logger } from "../lib/logger";
import { sendWA, saveJidMapping, empresaWhatsAppConectado, type WaConfig } from "./whatsappCommands";

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

// Lembrete de PRÉ-vencimento — só pra contratos que ainda vão vencer (7/3/1
// dias antes). O dia do vencimento em diante já é responsabilidade da
// cobrança diária de atraso (overdueAlerts.ts::cobrarClientesAtrasoCronico),
// não desse lembrete.
const TARGETS = [
  { days: 7, label: "7 dias", icon: "🟢" },
  { days: 3, label: "3 dias", icon: "🟡" },
  { days: 1, label: "1 dia",  icon: "🟠" },
];

// Roda diariamente — notifica admin global + cada empresa com telegram configurado
export async function checkDueDateNotifications(): Promise<void> {
  // Busca todas as empresas com telegram configurado
  const companies = await db
    .select({
      id:                companiesTable.id,
      name:              companiesTable.name,
      telegramBotToken:  companiesTable.telegramBotToken,
      telegramChatId:    companiesTable.telegramChatId,
      whatsappInstance:  companiesTable.whatsappInstance,
      whatsappStatus:    companiesTable.whatsappStatus,
      whatsappPhone:     companiesTable.whatsappPhone,
    })
    .from(companiesTable);

  for (const { days, label, icon } of TARGETS) {
    const targetDate = addDays(days);

    const rows = await db
      .select({
        invoiceId:           invoicesTable.id,
        amount:              invoicesTable.amount,
        dueDate:             invoicesTable.dueDate,
        notes:               invoicesTable.notes,
        companyId:           invoicesTable.companyId,
        clientId:            clientsTable.id,
        clientName:          clientsTable.name,
        clientPhone:         clientsTable.phone,
        clientWhatsappJid:   clientsTable.whatsappJid,
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

      const alerteHoje = days === 0
        ? `⚠️ <b>Atenção:</b> pagamentos realizados após o vencimento estão sujeitos a multa e juros de mora. Regularize hoje e evite encargos adicionais.\n\n`
        : "";

      const clientMsg =
        `━━━━━━━━━━━━━━━━━━━\n` +
        `  🏦 <b>LASTRO CAPITAL</b>\n` +
        `━━━━━━━━━━━━━━━━━━━\n\n` +
        `${icon} Olá, <b>${r.clientName ?? "cliente"}</b>!\n\n` +
        `Seu pagamento de <b>${valor}</b> ${venceTexto}.\n\n` +
        (r.notes ? `📝 ${r.notes}\n\n` : "") +
        alerteHoje +
        `Use /start para consultar seus contratos, ver detalhes e realizar pagamentos. 🤖\n\n` +
        `Qualquer dúvida, entre em contato conosco. 😊`;

      await sendTelegram(r.companyBotToken!, r.clientTelegramChatId!, clientMsg);
      logger.info(`[Telegram] Cliente "${r.clientName}" notificado diretamente (vence em ${label})`);
    }

    // 4. Notifica clientes via WhatsApp usando a instância de cada empresa
    const waApiUrl = process.env["EVOLUTION_SERVER_URL"];
    const waApiKey = process.env["EVOLUTION_API_KEY"];
    if (waApiUrl && waApiKey) {
      const waClientRows = rows.filter((r) => r.clientPhone);

      for (const r of waClientRows) {
        const company = companies.find((c) => c.id === r.companyId);
        if (!company?.whatsappInstance || !(await empresaWhatsAppConectado(company))) {
          logger.warn(`[WA] Empresa ${r.companyId} sem WhatsApp conectado — pulando cliente ${r.clientName}`);
          continue;
        }

        const waCfg: WaConfig = {
          apiUrl:     waApiUrl,
          apiKey:     waApiKey,
          instance:   company.whatsappInstance,
          adminPhone: company.whatsappPhone ?? "",
          companyId:  company.id,
        };

        const valor  = r.amount ? `R$ ${parseFloat(r.amount).toFixed(2).replace(".", ",")}` : "—";
        const dueFmt = r.dueDate
          ? new Date(r.dueDate + "T00:00:00Z").toLocaleDateString("pt-BR", { timeZone: "UTC" })
          : targetDate;

        const venceTexto = days === 0
          ? `vence *hoje* (${dueFmt})`
          : days === 1
            ? `vence *amanhã* (${dueFmt})`
            : `vence em *${label}* (${dueFmt})`;

        const alerteHoje = days === 0
          ? `⚠️ *Atenção:* pagamentos realizados após o vencimento estão sujeitos a multa e juros de mora. Regularize hoje e evite encargos adicionais.\n\n`
          : "";

        const nomeEmpresa = (company.name ?? "").toUpperCase();

        const clientMsg =
          `━━━━━━━━━━━━━━━━━━━\n` +
          `  🏦 *${nomeEmpresa}*\n` +
          `━━━━━━━━━━━━━━━━━━━\n\n` +
          `${icon} Olá, *${r.clientName ?? "cliente"}*!\n\n` +
          `Seu pagamento de *${valor}* ${venceTexto}.\n\n` +
          (r.notes ? `📝 ${r.notes}\n\n` : "") +
          alerteHoje +
          `Responda *menu* para consultar seus contratos, ver detalhes e realizar pagamentos. 🤖\n\n` +
          `Qualquer dúvida, entre em contato conosco. 😊\n\n` +
          `*${company.name ?? ""}*`;

        // whatsapp_jid (@lid) é só pra reconhecer mensagens recebidas — pode ficar
        // desatualizado sem avisar (ver nota em overdueAlerts.ts). Envio sempre
        // pelo telefone, único canal verificado.
        const remoteJid = await sendWA(waCfg, r.clientPhone!, clientMsg).catch((e: any) => {
          logger.warn(`[WA] Falha ao notificar cliente ${r.clientName}: ${e.message}`);
          return null;
        });
        logger.info(`[WA] Cliente "${r.clientName}" notificado via WhatsApp — instância ${company.whatsappInstance} (vence em ${label})`);

        // Captura mapeamento @lid na resposta da Evolution e persiste no banco
        if (remoteJid?.endsWith("@lid") && r.clientId && remoteJid !== r.clientWhatsappJid) {
          await saveJidMapping(remoteJid, r.clientPhone!, r.companyId!).catch(() => {});
          logger.info(`[WA] @lid capturado via notificação: ${remoteJid} → ${r.clientName}`);
        }
      }
    }
  }
}
