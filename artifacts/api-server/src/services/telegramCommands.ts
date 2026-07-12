import { db, invoicesTable, clientsTable, companiesTable, debtsTable, cashFlowTable } from "@workspace/db";
import { eq, and, ilike, ne, or } from "drizzle-orm";
import { logger } from "../lib/logger";
import { removePendingPayment, savePendingPayment, sendWA, type WaConfig } from "./whatsappCommands";
import { monthsLate as calcMonthsLate, billableLateDays } from "./invoiceCalculator";

// ── Conversa para /cobranca ───────────────────────────────────────────────────

type ConvStep =
  | "client" | "select_client" | "amount" | "due_date" | "interest" | "late_fee"
  | "nc_name" | "nc_phone" | "nc_document" | "nc_referral"
  | "qt_client" | "qt_select_client" | "qt_select_invoice" | "qt_type"
  | "cs_select_invoice"
  // ── fluxo do cliente ──
  | "cl_menu" | "cl_identify" | "cl_identify_multi" | "cl_select_invoice_payment" | "cl_payment_type" | "cl_await_comprovante";

interface ConvState {
  step: ConvStep;
  companyIdFilter?: number;
  isClientFlow?: boolean;
  // /cobranca
  clientId?: number;
  clientName?: string;
  clientCompanyId?: number;
  amount?: number;
  dueDate?: string;
  interestRate?: number;
  lateFee?: number;
  pendingClients?: Array<{ id: number; name: string; companyId: number; companyName: string | null }>;
  // /novocliente
  nc_name?: string;
  nc_phone?: string;
  nc_document?: string;
  nc_referral?: string;
  // /<nome> — seleção de contrato
  cs_clientName?: string;
  cs_clientPhone?: string;
  cs_clientRef?: string;
  cs_invoices?: Array<typeof invoicesTable.$inferSelect>;
  // /quitacao
  qt_pendingClients?: Array<{ id: number; name: string; companyId: number }>;
  qt_clientId?: number;
  qt_clientName?: string;
  qt_clientCompanyId?: number;
  qt_invoices?: Array<{
    id: number; amount: string | null; dueDate: string | null;
    status: string; interestRate: string | null; lateFee: string | null;
    daysLate: number | null; interestPaid: boolean | null; recurrence: string | null;
  }>;
  qt_invoiceIdx?: number;
  // cliente
  cl_action?: "contratos" | "extrato" | "pagar";
  cl_clientId?: number;
  cl_clientName?: string;
  cl_totalAmount?: number;
  cl_jurosAmount?: number;
  cl_paymentType?: "total" | "juros";
  cl_matchedClients?: Array<{ id: number; name: string; document: string | null }>;
  cl_invoiceId?: number;
  cl_invoices?: Array<typeof invoicesTable.$inferSelect>;
}

const conversations = new Map<number, ConvState>();

function parseBRL(text: string): number {
  return parseFloat(text.trim().replace(/[R$\s.]/g, "").replace(",", ".")) || 0;
}

// Divisor de dias por período, usado só pra fatiar o detalhamento visual por
// período nas mensagens — a contagem de quantos períodos estão em atraso vem
// de calcMonthsLate (invoiceCalculator.ts), que usa o vencimento real em vez
// de dias÷30.
const PERIOD_DAYS: Record<string, number> = { daily: 1, weekly: 7, biweekly: 14, monthly: 30 };
function periodLabel(recurrence: string | null | undefined, count: number): string {
  const labels: Record<string, [string, string]> = {
    daily:    ["dia",      "dias"],
    weekly:   ["semana",   "semanas"],
    biweekly: ["quinzena", "quinzenas"],
    monthly:  ["mês",      "meses"],
  };
  const [s, p] = labels[recurrence ?? "monthly"] ?? ["mês", "meses"];
  return count === 1 ? s : p;
}

function parseDateBR(text: string): string | null {
  const m = text.trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const year = y.length === 2 ? `20${y}` : y;
  return `${year}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

async function sendTelegramWithButtons(
  token: string, chatId: number | string, text: string,
  buttons: Array<{ text: string; callback_data: string }>,
): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId, text, parse_mode: "HTML",
        reply_markup: { inline_keyboard: [buttons] },
      }),
    });
  } catch {}
}

async function answerCallback(token: string, callbackQueryId: string, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
    });
  } catch {}
}

async function editMsgRemoveButtons(token: string, chatId: number | string, messageId: number, newText: string): Promise<void> {
  // Tenta editMessageText (mensagens de texto); se falhar (ex: mensagem de foto), usa editMessageCaption
  const base = { chat_id: chatId, message_id: messageId, parse_mode: "HTML", reply_markup: { inline_keyboard: [] } };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...base, text: newText }),
    });
    if (res.ok) return;
  } catch {}
  try {
    await fetch(`https://api.telegram.org/bot${token}/editMessageCaption`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...base, caption: newText }),
    });
  } catch {}
}

function buildWaConfig(): WaConfig | null {
  const apiUrl     = process.env["EVOLUTION_SERVER_URL"];
  const apiKey     = process.env["EVOLUTION_API_KEY"];
  const instance   = process.env["WHATSAPP_INSTANCE"];
  const adminPhone = process.env["WHATSAPP_ADMIN_PHONE"];
  if (!apiUrl || !apiKey || !instance || !adminPhone) return null;
  const companyId = process.env["WHATSAPP_COMPANY_ID"] ? parseInt(process.env["WHATSAPP_COMPANY_ID"], 10) : undefined;
  return { apiUrl, apiKey, instance, adminPhone, companyId };
}

async function forwardTelegramMessage(token: string, toChatId: number | string, fromChatId: number, messageId: number): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/forwardMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: toChatId, from_chat_id: fromChatId, message_id: messageId }),
    });
  } catch {}
}

async function handleConversationStep(
  token: string,
  chatId: number,
  text: string,
  state: ConvState,
): Promise<void> {
  const input = text.trim();

  if (input.toLowerCase() === "/cancelar") {
    conversations.delete(chatId);
    await sendTelegram(token, chatId, "❌ Registro cancelado.");
    return;
  }

  switch (state.step) {
    case "client": {
      const conditions: any[] = [ilike(clientsTable.name, `%${input}%`)];
      if (state.companyIdFilter) conditions.push(eq(clientsTable.companyId, state.companyIdFilter));

      const found = await db
        .select({
          id:          clientsTable.id,
          name:        clientsTable.name,
          companyId:   clientsTable.companyId,
          companyName: companiesTable.name,
        })
        .from(clientsTable)
        .leftJoin(companiesTable, eq(clientsTable.companyId, companiesTable.id))
        .where(and(...conditions))
        .orderBy(clientsTable.name);

      if (found.length === 0) {
        await sendTelegram(token, chatId, `❌ Nenhum cliente encontrado com "<b>${input}</b>".\nDigite outro nome ou /cancelar.`);
        return;
      }

      if (found.length === 1) {
        const c = found[0];
        state.clientId = c.id;
        state.clientName = c.name;
        state.clientCompanyId = c.companyId;
        state.step = "amount";
        conversations.set(chatId, state);
        await sendTelegram(token, chatId, `✅ Cliente: <b>${c.name}</b>\n\n💰 Valor da cobrança (R$):`);
        return;
      }

      // Múltiplos — pede para escolher
      state.pendingClients = found;
      state.step = "select_client";
      conversations.set(chatId, state);
      const list = found.map((c, i) => `${i + 1}. <b>${c.name}</b>${c.companyName ? ` (${c.companyName})` : ""}`).join("\n");
      await sendTelegram(token, chatId, `Encontrei ${found.length} clientes:\n\n${list}\n\nDigite o número desejado:`);
      return;
    }

    case "select_client": {
      const idx = parseInt(input) - 1;
      const list = state.pendingClients ?? [];
      if (isNaN(idx) || idx < 0 || idx >= list.length) {
        await sendTelegram(token, chatId, `❌ Número inválido. Digite um número entre 1 e ${list.length}:`);
        return;
      }
      const c = list[idx];
      state.clientId = c.id;
      state.clientName = c.name;
      state.clientCompanyId = c.companyId;
      state.step = "amount";
      conversations.set(chatId, state);
      await sendTelegram(token, chatId, `✅ Cliente: <b>${c.name}</b>\n\n💰 Valor da cobrança (R$):`);
      return;
    }

    case "amount": {
      const amount = parseBRL(input);
      if (!amount || amount <= 0) {
        await sendTelegram(token, chatId, "❌ Valor inválido. Exemplos: <code>500</code> ou <code>500,00</code>:");
        return;
      }
      state.amount = amount;
      state.step = "due_date";
      conversations.set(chatId, state);
      await sendTelegram(token, chatId, `💰 Valor: <b>R$ ${amount.toFixed(2).replace(".", ",")}</b>\n\n📅 Data de vencimento (DD/MM/AAAA):`);
      return;
    }

    case "due_date": {
      const date = parseDateBR(input);
      if (!date) {
        await sendTelegram(token, chatId, "❌ Data inválida. Use o formato DD/MM/AAAA (ex: <code>15/07/2026</code>):");
        return;
      }
      state.dueDate = date;
      state.step = "interest";
      conversations.set(chatId, state);
      await sendTelegram(token, chatId, `📅 Vencimento: <b>${input}</b>\n\n📈 Taxa de juros % (0 para nenhum):`);
      return;
    }

    case "interest": {
      const rate = parseFloat(input.replace(",", ".")) || 0;
      state.interestRate = rate;
      state.step = "late_fee";
      conversations.set(chatId, state);
      await sendTelegram(token, chatId, `📈 Juros: <b>${rate}%</b>\n\n⚠️ Multa por dia R$ (0 para nenhum):`);
      return;
    }

    case "late_fee": {
      const fee = parseBRL(input);
      state.lateFee = fee;

      const companyId = state.clientCompanyId!;
      const today = new Date().toISOString().split("T")[0];
      const isOverdue = state.dueDate! < today;

      const [invoice] = await db
        .insert(invoicesTable)
        .values({
          companyId,
          clientId:     state.clientId!,
          amount:       String(state.amount!.toFixed(2)),
          dueDate:      state.dueDate!,
          status:       isOverdue ? "overdue" : "pending",
          interestRate: String(state.interestRate ?? 0),
          lateFee:      String(fee),
          daysLate:     0,
          recurrence:   null,
        })
        .returning();

      conversations.delete(chatId);

      const dueFmt = state.dueDate!.split("-").reverse().join("/");
      await sendTelegram(
        token,
        chatId,
        `✅ <b>Cobrança registrada!</b>\n\n` +
        `👤 Cliente: <b>${state.clientName}</b>\n` +
        `💰 Valor: <b>R$ ${state.amount!.toFixed(2).replace(".", ",")}</b>\n` +
        `📅 Vencimento: <b>${dueFmt}</b>\n` +
        `📈 Juros: <b>${state.interestRate ?? 0}%</b>\n` +
        `⚠️ Multa/dia: <b>R$ ${fee.toFixed(2).replace(".", ",")}</b>\n` +
        `📋 Status: <b>${isOverdue ? "Vencido" : "Pendente"}</b>\n` +
        `🔢 ID: #${invoice.id}`,
      );
      return;
    }

    // ── /novocliente ─────────────────────────────────────────────────────────

    case "nc_name": {
      if (input.length < 2) {
        await sendTelegram(token, chatId, "❌ Nome muito curto. Digite o nome completo:");
        return;
      }
      state.nc_name = input;
      state.step = "nc_phone";
      conversations.set(chatId, state);
      await sendTelegram(token, chatId, `👤 Nome: <b>${input}</b>\n\n📱 Telefone/WhatsApp (ou <code>-</code> para pular):`);
      return;
    }

    case "nc_phone": {
      state.nc_phone = input === "-" ? undefined : input;
      state.step = "nc_document";
      conversations.set(chatId, state);
      await sendTelegram(token, chatId, `📱 Telefone: <b>${state.nc_phone ?? "—"}</b>\n\n🪪 CPF/CNPJ (ou <code>-</code> para pular):`);
      return;
    }

    case "nc_document": {
      state.nc_document = input === "-" ? undefined : input;
      state.step = "nc_referral";
      conversations.set(chatId, state);
      await sendTelegram(token, chatId, `🪪 Documento: <b>${state.nc_document ?? "—"}</b>\n\n🔗 Indicação — quem indicou? (ou <code>-</code> para pular):`);
      return;
    }

    case "nc_referral": {
      state.nc_referral = input === "-" ? undefined : input;

      if (!state.companyIdFilter) {
        conversations.delete(chatId);
        await sendTelegram(token, chatId, "❌ Não foi possível identificar a empresa. Use o bot da sua empresa para cadastrar clientes.");
        return;
      }

      const [client] = await db
        .insert(clientsTable)
        .values({
          companyId:      state.companyIdFilter,
          name:           state.nc_name!,
          phone:          state.nc_phone ?? null,
          document:       state.nc_document ?? null,
          referralSource: state.nc_referral ?? null,
          status:         "active",
        })
        .returning();

      conversations.delete(chatId);

      await sendTelegram(
        token,
        chatId,
        `✅ <b>Cliente cadastrado!</b>\n\n` +
        `👤 Nome: <b>${client.name}</b>\n` +
        `📱 Telefone: <b>${client.phone ?? "—"}</b>\n` +
        `🪪 Documento: <b>${client.document ?? "—"}</b>\n` +
        `🔗 Indicação: <b>${client.referralSource ?? "—"}</b>\n` +
        `🔢 ID: #${client.id}\n\n` +
        `<i>Use /cobranca para registrar uma cobrança para este cliente.</i>`,
      );
      return;
    }

    // ── /quitacao ─────────────────────────────────────────────────────────────

    case "qt_client": {
      const conditions: any[] = [ilike(clientsTable.name, `%${input}%`)];
      if (state.companyIdFilter) conditions.push(eq(clientsTable.companyId, state.companyIdFilter));

      const found = await db
        .select({ id: clientsTable.id, name: clientsTable.name, companyId: clientsTable.companyId })
        .from(clientsTable)
        .where(and(...conditions))
        .orderBy(clientsTable.name);

      if (found.length === 0) {
        await sendTelegram(token, chatId, `❌ Nenhum cliente encontrado com "<b>${input}</b>".\nDigite outro nome ou /cancelar.`);
        return;
      }

      const resolveClient = async (c: { id: number; name: string; companyId: number }) => {
        const invs = await db
          .select({
            id: invoicesTable.id, amount: invoicesTable.amount, dueDate: invoicesTable.dueDate,
            status: invoicesTable.status, interestRate: invoicesTable.interestRate,
            lateFee: invoicesTable.lateFee, daysLate: invoicesTable.daysLate,
            interestPaid: invoicesTable.interestPaid, recurrence: invoicesTable.recurrence,
          })
          .from(invoicesTable)
          .where(and(eq(invoicesTable.clientId, c.id), ne(invoicesTable.status, "paid")))
          .orderBy(invoicesTable.dueDate);
        return invs;
      };

      if (found.length === 1) {
        const c = found[0];
        const invs = await resolveClient(c);
        if (invs.length === 0) {
          conversations.delete(chatId);
          await sendTelegram(token, chatId, `✅ <b>${c.name}</b> não possui cobranças em aberto.`);
          return;
        }
        state.qt_clientId = c.id;
        state.qt_clientName = c.name;
        state.qt_clientCompanyId = c.companyId;
        state.qt_invoices = invs;
        if (invs.length === 1) {
          state.qt_invoiceIdx = 0;
          state.step = "qt_type";
          conversations.set(chatId, state);
          await sendTelegram(token, chatId,
            `👤 Cliente: <b>${c.name}</b>\n\n📋 Cobrança em aberto:\n${qtFormatList([invs[0]])}\n\n💳 Tipo de quitação:\n<b>1</b> — Quitação total\n<b>2</b> — Só juros/multa\n\nDigite 1 ou 2:`);
        } else {
          state.step = "qt_select_invoice";
          conversations.set(chatId, state);
          await sendTelegram(token, chatId,
            `👤 Cliente: <b>${c.name}</b>\n\n📋 Selecione a cobrança:\n\n${qtFormatList(invs)}\n\nDigite o número:`);
        }
        return;
      }

      state.qt_pendingClients = found;
      state.step = "qt_select_client";
      conversations.set(chatId, state);
      const listMsg = found.map((c, i) => `${i + 1}. <b>${c.name}</b>`).join("\n");
      await sendTelegram(token, chatId, `Encontrei ${found.length} clientes:\n\n${listMsg}\n\nDigite o número desejado:`);
      return;
    }

    case "qt_select_client": {
      const idx = parseInt(input) - 1;
      const plist = state.qt_pendingClients ?? [];
      if (isNaN(idx) || idx < 0 || idx >= plist.length) {
        await sendTelegram(token, chatId, `❌ Número inválido. Digite um número entre 1 e ${plist.length}:`);
        return;
      }
      const c = plist[idx];
      const invs = await db
        .select({
          id: invoicesTable.id, amount: invoicesTable.amount, dueDate: invoicesTable.dueDate,
          status: invoicesTable.status, interestRate: invoicesTable.interestRate,
          lateFee: invoicesTable.lateFee, daysLate: invoicesTable.daysLate,
          interestPaid: invoicesTable.interestPaid, recurrence: invoicesTable.recurrence,
        })
        .from(invoicesTable)
        .where(and(eq(invoicesTable.clientId, c.id), ne(invoicesTable.status, "paid")))
        .orderBy(invoicesTable.dueDate);

      if (invs.length === 0) {
        conversations.delete(chatId);
        await sendTelegram(token, chatId, `✅ <b>${c.name}</b> não possui cobranças em aberto.`);
        return;
      }
      state.qt_clientId = c.id;
      state.qt_clientName = c.name;
      state.qt_clientCompanyId = c.companyId;
      state.qt_invoices = invs;
      if (invs.length === 1) {
        state.qt_invoiceIdx = 0;
        state.step = "qt_type";
        conversations.set(chatId, state);
        await sendTelegram(token, chatId,
          `👤 Cliente: <b>${c.name}</b>\n\n📋 Cobrança em aberto:\n${qtFormatList([invs[0]])}\n\n💳 Tipo de quitação:\n<b>1</b> — Quitação total\n<b>2</b> — Só juros/multa\n\nDigite 1 ou 2:`);
      } else {
        state.step = "qt_select_invoice";
        conversations.set(chatId, state);
        await sendTelegram(token, chatId,
          `👤 Cliente: <b>${c.name}</b>\n\n📋 Selecione a cobrança:\n\n${qtFormatList(invs)}\n\nDigite o número:`);
      }
      return;
    }

    case "qt_select_invoice": {
      const invs = state.qt_invoices ?? [];
      const idx = parseInt(input) - 1;
      if (isNaN(idx) || idx < 0 || idx >= invs.length) {
        await sendTelegram(token, chatId, `❌ Número inválido. Digite um número entre 1 e ${invs.length}:`);
        return;
      }
      state.qt_invoiceIdx = idx;
      state.step = "qt_type";
      conversations.set(chatId, state);
      await sendTelegram(token, chatId,
        `📋 Cobrança selecionada:\n${qtFormatList([invs[idx]])}\n\n💳 Tipo de quitação:\n<b>1</b> — Quitação total\n<b>2</b> — Só juros/multa\n\nDigite 1 ou 2:`);
      return;
    }

    case "qt_type": {
      const choice = input.trim();
      if (choice !== "1" && choice !== "2") {
        await sendTelegram(token, chatId, "❌ Opção inválida. Digite <b>1</b> para quitação total ou <b>2</b> para só juros/multa:");
        return;
      }

      const inv = (state.qt_invoices ?? [])[state.qt_invoiceIdx ?? 0];
      if (!inv) {
        conversations.delete(chatId);
        await sendTelegram(token, chatId, "❌ Cobrança não encontrada. Operação cancelada.");
        return;
      }

      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const due = inv.dueDate ? new Date(inv.dueDate + "T00:00:00Z") : null;
      const daysLate = inv.status === "overdue" && due
        ? Math.max(0, Math.floor((today.getTime() - due.getTime()) / 86_400_000))
        : (inv.daysLate ?? 0);
      const principal = parseFloat(inv.amount ?? "0") || 0;
      const feePerDay = parseFloat(inv.lateFee ?? "0") || 0;
      const rate      = parseFloat(inv.interestRate ?? "0") || 0;
      const monthsLateTg = inv.status === "overdue" ? calcMonthsLate(inv.dueDate, inv.recurrence) : 0;
      const multa     = feePerDay * billableLateDays(daysLate);
      const juros     = (principal * rate) / 100 * (monthsLateTg || 1);
      const companyId = state.qt_clientCompanyId!;
      const clientName = state.qt_clientName ?? "—";

      if (choice === "1") {
        const total = principal + multa + juros;
        await db.update(invoicesTable).set({ status: "paid", daysLate }).where(eq(invoicesTable.id, inv.id));
        await db.insert(cashFlowTable).values({
          companyId,
          type:        "income",
          amount:      String(total.toFixed(2)),
          description: `Quitação total — ${clientName}`,
          category:    "recebimento",
        });
        conversations.delete(chatId);
        await sendTelegram(token, chatId,
          `✅ <b>Quitação registrada!</b>\n\n` +
          `👤 Cliente: <b>${clientName}</b>\n` +
          `💰 Principal: ${fmtBRL(principal)}\n` +
          (multa > 0 ? `⚠️ Multa: ${fmtBRL(multa)}\n` : "") +
          (juros > 0 ? `📈 Juros: ${fmtBRL(juros)}\n` : "") +
          `💸 <b>Total recebido: ${fmtBRL(total)}</b>\n` +
          `📋 Status: ✅ Pago`);
        // Notificar cliente via WhatsApp
        try {
          const [clientRow] = await db.select({ phone: clientsTable.phone, whatsappJid: clientsTable.whatsappJid })
            .from(clientsTable).where(eq(clientsTable.id, state.qt_clientId!)).limit(1);
          const clientPhone = clientRow?.whatsappJid ?? clientRow?.phone;
          if (clientPhone) {
            const [comp] = await db.select({ whatsappInstance: companiesTable.whatsappInstance, whatsappPhone: companiesTable.whatsappPhone, whatsappStatus: companiesTable.whatsappStatus })
              .from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);
            const baseCfg = buildWaConfig();
            const waCfg = baseCfg && comp?.whatsappStatus === "connected"
              ? { ...baseCfg, instance: comp.whatsappInstance ?? baseCfg.instance, companyId }
              : null;
            if (waCfg) {
              const dueFmt = inv.dueDate ? new Date(inv.dueDate + "T00:00:00Z").toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "";
              await sendWA(waCfg, clientPhone,
                `✅ *Pagamento confirmado!*\n\nOlá, *${clientName}*!\n\nSeu pagamento foi registrado com sucesso.\n\n📋 Contrato: *#${inv.id}*${dueFmt ? `\n📅 Vencimento: ${dueFmt}` : ""}\n💸 Valor: *${fmtBRL(total)}*\n\nObrigado! 🙏`);
            }
          }
        } catch {}
      } else {
        const taxas = multa + juros;
        if (taxas <= 0) {
          conversations.delete(chatId);
          await sendTelegram(token, chatId,
            `ℹ️ <b>${clientName}</b> não possui juros ou multa acumulados (${daysLate}d de atraso sem taxa configurada).\n\nUse a opção <b>1</b> para quitação total.`);
          return;
        }
        // Fecha dívida aberta
        await db.update(debtsTable).set({ status: "closed" })
          .where(and(eq(debtsTable.invoiceId, inv.id), eq(debtsTable.status, "open")));

        // Avança recorrência se houver; senão apenas marca interestPaid
        let newDueDateFmt = "";
        let newStatusLine = "📋 Cobrança permanece em aberto (principal não quitado)";
        const recurrence = inv.recurrence;
        const currentDueDate = inv.dueDate;
        if (recurrence && recurrence !== "none" && currentDueDate) {
          const base = new Date(currentDueDate + "T12:00:00Z");
          if (recurrence === "monthly")   base.setUTCMonth(base.getUTCMonth() + 1);
          else if (recurrence === "weekly")   base.setUTCDate(base.getUTCDate() + 7);
          else if (recurrence === "biweekly") base.setUTCDate(base.getUTCDate() + 14);
          else if (recurrence === "daily")    base.setUTCDate(base.getUTCDate() + 1);
          const newDueDate = base.toISOString().split("T")[0];
          const todayStr   = new Date().toISOString().split("T")[0];
          const newStatus  = newDueDate > todayStr ? "current" : "overdue";
          await db.update(invoicesTable)
            .set({ dueDate: newDueDate, status: newStatus, interestPaid: false })
            .where(eq(invoicesTable.id, inv.id));
          if (newStatus === "overdue") {
            const ex = await db.select().from(debtsTable)
              .where(and(eq(debtsTable.invoiceId, inv.id), eq(debtsTable.status, "open")));
            if (ex.length === 0) {
              await db.insert(debtsTable).values({
                companyId, clientId: state.qt_clientId!, invoiceId: inv.id, status: "open", daysOverdue: 0,
              });
            }
          }
          newDueDateFmt = new Date(newDueDate + "T00:00:00Z").toLocaleDateString("pt-BR", { timeZone: "UTC" });
          newStatusLine = newStatus === "current"
            ? `📋 Status: <b>Em Dia ✅</b>\n📅 Próx. vencimento: <b>${newDueDateFmt}</b>`
            : `📋 Status: <b>Vencido ⚠️</b>\n📅 Nova data: <b>${newDueDateFmt}</b>`;
        } else {
          // Sem recorrência: marca juros pagos e muda vencido → em dia
          const noRecStatusTg = inv.status === "overdue" ? "current" : inv.status;
          await db.update(invoicesTable)
            .set({ interestPaid: true, status: noRecStatusTg })
            .where(eq(invoicesTable.id, inv.id));
          newStatusLine = `📋 Status: <b>Em Dia ✅</b>`;
        }

        await db.insert(cashFlowTable).values({
          companyId,
          type:        "income",
          amount:      String(taxas.toFixed(2)),
          description: `Pagamento juros/multa — ${clientName}`,
          category:    "juros",
        });
        conversations.delete(chatId);
        await sendTelegram(token, chatId,
          `✅ <b>Pagamento de juros/multa registrado!</b>\n\n` +
          `👤 Cliente: <b>${clientName}</b>\n` +
          (multa > 0 ? `⚠️ Multa paga: ${fmtBRL(multa)}\n` : "") +
          (juros > 0 ? `📈 Juros pagos: ${fmtBRL(juros)}\n` : "") +
          `💸 <b>Total recebido: ${fmtBRL(taxas)}</b>\n` +
          newStatusLine);
      }
      return;
    }

    // ── /<nome> seleção de contrato ───────────────────────────────────────────

    case "cs_select_invoice": {
      const invs = state.cs_invoices ?? [];
      const idx = parseInt(input) - 1;
      if (isNaN(idx) || idx < 0 || idx >= invs.length) {
        await sendTelegram(token, chatId, `❌ Número inválido. Digite um número entre 1 e ${invs.length} ou /cancelar:`);
        return;
      }
      conversations.delete(chatId);
      const msg = buildInvoiceDetail(invs[idx], state.cs_clientName ?? "—", state.cs_clientPhone, state.cs_clientRef);
      await sendTelegram(token, chatId, msg);
      return;
    }
  }
}

function buildInvoiceDetail(
  inv: typeof invoicesTable.$inferSelect,
  clientName: string,
  phone?: string,
  referral?: string,
): string {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const due = inv.dueDate ? new Date(inv.dueDate + "T00:00:00Z") : null;
  const daysLate = inv.status === "overdue" && due
    ? Math.max(0, Math.floor((today.getTime() - due.getTime()) / 86_400_000))
    : (inv.daysLate ?? 0);
  const principal  = parseFloat(inv.amount ?? "0") || 0;
  const feePerDay  = parseFloat(inv.lateFee ?? "0") || 0;
  const rate       = parseFloat(inv.interestRate ?? "0") || 0;
  const monthsLate = inv.status === "overdue" ? calcMonthsLate(inv.dueDate, inv.recurrence) : 0;
  const multa      = feePerDay * billableLateDays(daysLate);
  const jurosMes   = (principal * rate) / 100;
  const jurosTotal = jurosMes * monthsLate;
  const total      = principal + multa + (monthsLate > 0 ? jurosTotal : 0);
  const dueFmt     = due ? due.toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "—";
  const statusLabel = STATUS_LABEL[inv.status] ?? inv.status;
  const phoneTag   = phone ? ` | ${phone}` : "";
  const refTag     = referral && referral !== "invite_link" ? `\n🔗 Indicação: ${referral}` : "";

  let msg =
    `👤 <b>${clientName}</b>${phoneTag}${refTag}\n` +
    `📋 <b>Contrato #${inv.id}</b>\n` +
    `${statusLabel}\n\n` +
    `💰 <b>Valor Principal:</b> ${fmtBRL(principal)}\n` +
    `📅 <b>Vencimento:</b> ${dueFmt}`;

  if (rate > 0)   msg += `\n📈 <b>Juros:</b> ${inv.interestRate}%/mês`;
  if (feePerDay > 0) msg += `\n⚠️ <b>Multa:</b> ${fmtBRL(feePerDay)}/dia`;
  if (inv.recurrence) msg += `\n🔄 Recorrência: ${inv.recurrence}`;

  if (inv.status === "overdue" && daysLate > 0) {
    const periodDivisor = PERIOD_DAYS[inv.recurrence ?? "monthly"] ?? 30;
    msg += `\n\n⏳ <b>Dias em atraso:</b> ${daysLate} dias`;
    msg += `\n📆 <b>Períodos em atraso:</b> ${monthsLate} ${periodLabel(inv.recurrence, monthsLate)}`;

    if (monthsLate > 1 && (multa > 0 || jurosMes > 0)) {
      msg += `\n\n📊 <b>Detalhamento por período:</b>`;
      for (let m = 1; m <= monthsLate; m++) {
        const daysInPeriod = m < monthsLate ? periodDivisor : daysLate - periodDivisor * (monthsLate - 1);
        // Carência de 2 dias só se aplica uma vez, no início do 1º período.
        const billableDaysInPeriod = m === 1 ? billableLateDays(daysInPeriod) : daysInPeriod;
        const multaPeriod = feePerDay * billableDaysInPeriod;
        const subtotalPeriod = jurosMes + multaPeriod;
        msg += `\n\n📅 <b>Período ${m}:</b>`;
        if (jurosMes > 0) msg += `\n   💵 Juros: ${fmtBRL(jurosMes)}`;
        if (multaPeriod > 0) msg += `\n   💸 Multa (${billableDaysInPeriod}d): ${fmtBRL(multaPeriod)}`;
        msg += `\n   Subtotal: ${fmtBRL(subtotalPeriod)}`;
      }
      msg += "\n";
    } else {
      if (jurosMes > 0) msg += `\n\n💵 <b>Juros acumulados:</b> ${fmtBRL(jurosTotal)}`;
      if (multa > 0)    msg += `\n💸 <b>Multa total:</b> ${fmtBRL(multa)}`;
    }

    msg += `\n\n🧾 <b>Total para quitação hoje:</b> ${fmtBRL(total)}`;
  }

  msg += `\n\n📝 <b>Observação:</b>`;
  if (inv.notes) {
    msg += `\n${inv.notes}`;
    if (inv.notesUpdatedAt) {
      const d = new Date(inv.notesUpdatedAt);
      msg += `\n<i>Atualizado em ${d.toLocaleDateString("pt-BR", { timeZone: "UTC" })} às ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })}</i>`;
    }
  } else {
    msg += `\nNenhuma observação cadastrada.`;
  }

  msg += `\n\n━━━━━━━━━━━━━━━━━━━━`;
  return msg;
}

function qtFormatList(
  invoices: Array<{
    amount: string | null; dueDate: string | null; status: string;
    interestRate: string | null; lateFee: string | null; daysLate: number | null;
  }>,
): string {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return invoices
    .map((inv, i) => {
      const due = inv.dueDate ? new Date(inv.dueDate + "T00:00:00Z") : null;
      const daysLate = inv.status === "overdue" && due
        ? Math.max(0, Math.floor((today.getTime() - due.getTime()) / 86_400_000))
        : (inv.daysLate ?? 0);
      const principal = parseFloat(inv.amount ?? "0") || 0;
      const feePerDay = parseFloat(inv.lateFee ?? "0") || 0;
      const rate      = parseFloat(inv.interestRate ?? "0") || 0;
      const multa     = feePerDay * billableLateDays(daysLate);
      const juros     = (principal * rate) / 100;
      const total     = principal + multa + juros;
      const dueFmt    = due ? due.toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "—";
      const statusTag = inv.status === "overdue" ? `⚠️ Vencido ${daysLate}d` : "🕐 Pendente";
      let line = `${invoices.length > 1 ? `${i + 1}. ` : ""}${statusTag} — vence ${dueFmt}\n   💰 Principal: ${fmtBRL(principal)}`;
      if (multa > 0) line += `\n   ⚠️ Multa: ${fmtBRL(multa)}`;
      if (juros > 0) line += `\n   📈 Juros: ${fmtBRL(juros)}`;
      if (multa > 0 || juros > 0) line += `\n   💸 <b>Total: ${fmtBRL(total)}</b>`;
      return line;
    })
    .join("\n\n");
}

async function sendTelegram(token: string, chatId: string | number, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
  } catch (e: any) {
    logger.warn(`[TelegramCmd] Falha ao enviar: ${e.message}`);
  }
}

function fmtBRL(v: number): string {
  return `R$ ${v.toFixed(2).replace(".", ",")}`;
}

async function buildVencidosMessage(companyId?: number, referral?: string): Promise<string> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const conditions: any[] = [eq(invoicesTable.status, "overdue")];
  if (companyId) conditions.push(eq(invoicesTable.companyId, companyId));
  if (referral)  conditions.push(ilike(clientsTable.referralSource, `%${referral}%`));

  const rows = await db
    .select({
      invoiceId:      invoicesTable.id,
      clientName:     clientsTable.name,
      clientPhone:    clientsTable.phone,
      referralSource: clientsTable.referralSource,
      amount:         invoicesTable.amount,
      dueDate:        invoicesTable.dueDate,
      lateFee:        invoicesTable.lateFee,
      interestRate:   invoicesTable.interestRate,
      recurrence:     invoicesTable.recurrence,
      notes:          invoicesTable.notes,
      notesUpdatedAt: invoicesTable.notesUpdatedAt,
      companyName:    companiesTable.name,
    })
    .from(invoicesTable)
    .leftJoin(clientsTable,   eq(invoicesTable.clientId,  clientsTable.id))
    .leftJoin(companiesTable, eq(invoicesTable.companyId, companiesTable.id))
    .where(and(...conditions))
    .orderBy(invoicesTable.dueDate);

  const filterLabel = referral ? ` — indicação <b>${referral}</b>` : "";

  if (rows.length === 0) {
    return referral
      ? `✅ Nenhum cliente em atraso com indicação <b>${referral}</b>.`
      : "✅ <b>Nenhum cliente em atraso no momento.</b>";
  }

  const dateStr = today.toLocaleDateString("pt-BR", { timeZone: "UTC" });
  const lines: string[] = [`📋 <b>Clientes em Atraso</b>${filterLabel} — ${dateStr}\n`];

  let totalGeral = 0;

  for (const row of rows) {
    const due = row.dueDate ? new Date(row.dueDate + "T00:00:00Z") : null;
    const daysLate = due
      ? Math.max(0, Math.floor((today.getTime() - due.getTime()) / 86_400_000))
      : 0;

    const principal  = parseFloat(row.amount  ?? "0") || 0;
    const feePerDay  = parseFloat(row.lateFee ?? "0") || 0;
    const rate       = parseFloat(row.interestRate ?? "0") || 0;
    const multa      = feePerDay * billableLateDays(daysLate);
    const monthsLate = calcMonthsLate(row.dueDate, row.recurrence) || 1;
    const jurosMes   = (principal * rate) / 100;
    const jurosTotal = jurosMes * monthsLate;
    const total      = principal + jurosTotal + multa;
    totalGeral      += total;
    const dueDateFmt  = due ? due.toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "—";
    const phone       = row.clientPhone ? ` | ${row.clientPhone}` : "";
    const companyTag  = !companyId && row.companyName ? `\n   🏢 ${row.companyName}` : "";
    const refTag      = !referral && row.referralSource ? `\n   🔗 Indicação: ${row.referralSource}` : "";

    let entry =
      `👤 <b>${row.clientName ?? "—"}</b>${phone}${companyTag}${refTag}\n` +
      `📋 Contrato #${row.invoiceId}\n` +
      `   📅 Venceu: ${dueDateFmt} | ⏳ <b>${daysLate} dias</b> (${monthsLate} ${periodLabel(row.recurrence, monthsLate)})\n` +
      `   💰 Principal: ${fmtBRL(principal)}`;

    if (jurosMes > 0) entry += `\n   📈 Juros (${rate}%): ${fmtBRL(jurosTotal)}`;
    if (multa > 0)    entry += `\n   ⚠️ Multa: ${billableLateDays(daysLate)}d × ${fmtBRL(feePerDay)} = ${fmtBRL(multa)}`;
    if (jurosMes > 0 || multa > 0) entry += `\n   💸 <b>Quitação: ${fmtBRL(total)}</b>`;
    if (row.notes)    entry += `\n   📝 <i>${row.notes}</i>`;

    lines.push(entry);
  }

  lines.push(
    `\n━━━━━━━━━━━━━━━━━━━━`,
    `📊 <b>${rows.length} cliente(s)</b> em atraso`,
    `💸 Total geral: <b>${fmtBRL(totalGeral)}</b>`,
  );

  return lines.join("\n");
}

const AJUDA_MSG = `📖 <b>Comandos disponíveis</b>

<b>Visão geral:</b>
/resumo — total geral da carteira

<b>Cobranças em atraso:</b>
/vencidos — lista todos os contratos em atraso
/vencidos<i>nome</i> — filtra por indicação (ex: /vencidoslucas)

<b>Busca rápida:</b>
/contrato 27 — detalhes completos do Contrato #27
/detalhes 27 — alias para /contrato
/cliente Lucas — ficha completa do cliente Lucas
/<i>nome</i> — atalho: ficha do cliente (ex: /nagila)

<b>Registrar:</b>
/novocliente — cadastrar novo cliente
/cobranca — registrar nova cobrança (passo a passo)
/quitacao — registrar pagamento, juros ou multa
/cancelar — cancelar operação em andamento

<b>Notificações para clientes:</b>
/vincular — cliente vincula Telegram para receber alertas de vencimento

<b>Ajuda:</b>
/ajuda — exibe esta mensagem

━━━━━━━━━━━━━━━━━━━━
🤖 <i>Lastro Capital — Bot de Gestão</i>`;

async function buildResumoMessage(companyId?: number): Promise<string> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const companyFilter = companyId ? eq(invoicesTable.companyId, companyId) : undefined;
  const clientFilter  = companyId ? eq(clientsTable.companyId, companyId) : undefined;

  const [allClients, allInvoices] = await Promise.all([
    db.select({ id: clientsTable.id, status: clientsTable.status })
      .from(clientsTable)
      .where(clientFilter),
    db.select({
      status:       invoicesTable.status,
      amount:       invoicesTable.amount,
      lateFee:      invoicesTable.lateFee,
      interestRate: invoicesTable.interestRate,
      dueDate:      invoicesTable.dueDate,
      daysLate:     invoicesTable.daysLate,
      recurrence:   invoicesTable.recurrence,
    })
      .from(invoicesTable)
      .where(companyFilter),
  ]);

  const totalClients  = allClients.length;
  const activeClients = allClients.filter((c) => c.status === "active").length;

  let totalCarteira   = 0;
  let totalVencido    = 0;
  let totalPendente   = 0;
  let totalPago       = 0;
  let totalMultas     = 0;
  let countVencido    = 0;
  let countPendente   = 0;

  for (const inv of allInvoices) {
    const principal = parseFloat(inv.amount ?? "0") || 0;
    const feePerDay = parseFloat(inv.lateFee ?? "0") || 0;
    const rate      = parseFloat(inv.interestRate ?? "0") || 0;

    if (inv.status === "paid") {
      totalPago += principal;
      continue;
    }

    const due = inv.dueDate ? new Date(inv.dueDate + "T00:00:00Z") : null;
    const daysLate = inv.status === "overdue" && due
      ? Math.max(0, Math.floor((today.getTime() - due.getTime()) / 86_400_000))
      : (inv.daysLate ?? 0);

    const multa = billableLateDays(daysLate) * feePerDay;
    const periods = inv.status === "overdue" ? calcMonthsLate(inv.dueDate, inv.recurrence) : 0;
    const juros = (principal * rate) / 100 * periods;
    const total = principal + juros + multa;

    totalCarteira += total;

    if (inv.status === "overdue") {
      totalVencido += total;
      totalMultas  += multa + juros;
      countVencido++;
    } else {
      totalPendente += principal;
      countPendente++;
    }
  }

  const dateStr = today.toLocaleDateString("pt-BR", { timeZone: "UTC" });

  return [
    `📊 <b>Resumo da Carteira</b> — ${dateStr}`,
    ``,
    `👥 <b>Clientes</b>`,
    `   Total: <b>${totalClients}</b> | Ativos: <b>${activeClients}</b>`,
    ``,
    `💼 <b>Carteira Ativa</b>`,
    `   Total em aberto: <b>${fmtBRL(totalCarteira)}</b>`,
    ``,
    `⚠️ <b>Vencidos</b>`,
    `   ${countVencido} cobrança(s): <b>${fmtBRL(totalVencido)}</b>`,
    `   Juros/multas acumulados: <b>${fmtBRL(totalMultas)}</b>`,
    ``,
    `🕐 <b>A Receber</b>`,
    `   ${countPendente} cobrança(s): <b>${fmtBRL(totalPendente)}</b>`,
    ``,
    `✅ <b>Já Recebido</b>`,
    `   ${fmtBRL(totalPago)}`,
  ].join("\n");
}

const STATUS_LABEL: Record<string, string> = {
  overdue:   "⚠️ Vencido",
  pending:   "🕐 Pendente",
  paid:      "✅ Pago",
  current:   "🟢 Em Dia",
  requested: "📋 Solicitação",
};

async function buildClientMessage(name: string, companyId?: number): Promise<string> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const clientConditions: any[] = [ilike(clientsTable.name, `%${name}%`)];
  if (companyId) clientConditions.push(eq(clientsTable.companyId, companyId));

  const clients = await db
    .select()
    .from(clientsTable)
    .where(and(...clientConditions))
    .orderBy(clientsTable.name);

  if (clients.length === 0) {
    return `❌ Nenhum cliente encontrado com o nome <b>${name}</b>.`;
  }

  const lines: string[] = [];

  for (const client of clients) {
    const invoices = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.clientId, client.id))
      .orderBy(invoicesTable.dueDate);

    const phone   = client.phone ? ` | ${client.phone}` : "";
    const refTag  = client.referralSource && client.referralSource !== "invite_link"
      ? `\n🔗 Indicação: ${client.referralSource}`
      : "";

    const todayMs = Date.now();
    const overdueInvCount = invoices
      .filter(i => i.status === "overdue")
      .reduce((sum, i) => {
        if (!i.dueDate) return sum + 1;
        const daysLate = Math.max(0, Math.floor((todayMs - new Date(i.dueDate + "T00:00:00Z").getTime()) / 86_400_000));
        return sum + Math.max(1, calcMonthsLate(i.dueDate, i.recurrence));
      }, 0);
    const overdueInvTag = overdueInvCount > 0
      ? ` | ⚠️ <b>${overdueInvCount} parcela${overdueInvCount > 1 ? "s" : ""} em atraso</b>` : "";
    lines.push(`👤 <b>${client.name}</b>${phone}${refTag}`);
    if (invoices.length > 0) lines.push(`📋 ${invoices.length} contrato${invoices.length > 1 ? "s" : ""}${overdueInvTag}`);

    if (invoices.length === 0) {
      lines.push(`   Sem cobranças registradas.\n`);
      continue;
    }

    let totalAberto = 0;

    for (const inv of invoices) {
      const due = inv.dueDate ? new Date(inv.dueDate + "T00:00:00Z") : null;
      const daysLate = inv.status === "overdue" && due
        ? Math.max(0, Math.floor((today.getTime() - due.getTime()) / 86_400_000))
        : (inv.daysLate ?? 0);

      const principal  = parseFloat(inv.amount ?? "0") || 0;
      const feePerDay  = parseFloat(inv.lateFee ?? "0") || 0;
      const rate       = parseFloat(inv.interestRate ?? "0") || 0;
      const monthsLate = inv.status === "overdue" ? calcMonthsLate(inv.dueDate, inv.recurrence) : 0;
      const multa      = feePerDay * billableLateDays(daysLate);
      const jurosMes   = (principal * rate) / 100;
      const jurosTotal = jurosMes * monthsLate;
      const total      = principal + multa + (monthsLate > 0 ? jurosTotal : 0);

      const dueFmt = due ? due.toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "—";
      const statusLabel = STATUS_LABEL[inv.status] ?? inv.status;

      let entry = `\n📋 <b>Contrato #${inv.id}</b> — ${statusLabel}\n   📅 Vencimento: ${dueFmt}\n   💰 Principal: ${fmtBRL(principal)}`;

      if (inv.status === "overdue") {
        if (daysLate > 0) entry += ` | ⏳ <b>${daysLate} dias em atraso</b>`;
        if (jurosMes > 0) {
          entry += monthsLate > 1
            ? `\n   📈 Juros: ${fmtBRL(jurosMes)}/mês × ${monthsLate} meses = <b>${fmtBRL(jurosTotal)}</b>`
            : `\n   📈 Juros: ${fmtBRL(jurosTotal)}`;
        }
        if (multa > 0) entry += `\n   ⚠️ Multa: ${billableLateDays(daysLate)}d × ${fmtBRL(feePerDay)} = ${fmtBRL(multa)}`;
        if (multa > 0 || jurosMes > 0) {
          const encargos = multa + (monthsLate > 0 ? jurosTotal : 0);
          entry += `\n   Subtotal: ${fmtBRL(encargos)}`;
          entry += `\n   💸 <b>Quitação: ${fmtBRL(total)}</b>`;
        }
        totalAberto += total;
      }

      if (inv.notes) entry += `\n   📝 <i>${inv.notes}</i>`;

      lines.push(entry);
    }

    const overdueCount = invoices
      .filter((i) => i.status === "overdue")
      .reduce((sum, i) => {
        if (!i.dueDate) return sum + 1;
        const daysLate = Math.max(0, Math.floor((todayMs - new Date(i.dueDate + "T00:00:00Z").getTime()) / 86_400_000));
        return sum + Math.max(1, calcMonthsLate(i.dueDate, i.recurrence));
      }, 0);
    if (overdueCount > 0) {
      lines.push(`\n   ━━━━━━━━━━━━━━━━━━━━`);
      lines.push(`   📊 ${overdueCount} parcela(s) em atraso`);
      lines.push(`   💸 Total em aberto: <b>${fmtBRL(totalAberto)}</b>`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

// ── Fluxo do Cliente ─────────────────────────────────────────────────────────

async function buildClientMenuMsg(companyId: number): Promise<string> {
  const [company] = await db.select({ name: companiesTable.name })
    .from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);
  const companyName = company?.name?.toUpperCase() ?? "LASTRO CAPITAL";
  return (
    `🏦 <b>LASTRO CAPITAL</b>\n` +
    `<b>${companyName}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `👋 Olá! Bem-vindo ao atendimento digital.\n\n` +
    `Como posso te ajudar hoje?\n\n` +
    `<b>1</b> — 📋 Localizar meu contrato\n` +
    `<b>2</b> — 📊 Ver meu extrato\n` +
    `<b>3</b> — 💳 Efetuar pagamento via PIX\n\n` +
    `<i>Responda com o número da opção.\nPara falar com a equipe, envie uma mensagem.</i>`
  );
}

async function sendClientContratos(token: string, chatId: number, clientId: number, clientName: string): Promise<void> {
  const invoices = await db.select().from(invoicesTable)
    .where(eq(invoicesTable.clientId, clientId)).orderBy(invoicesTable.dueDate);

  if (invoices.length === 0) {
    await sendTelegram(token, chatId, `📋 <b>${clientName}</b>, você não possui contratos registrados.`);
    return;
  }

  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  let msg = `📋 <b>Seus contratos — ${clientName}</b>\n\n`;
  invoices.forEach((inv, i) => {
    const due = inv.dueDate ? new Date(inv.dueDate + "T00:00:00Z") : null;
    const dueFmt = due ? due.toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "—";
    const principal = parseFloat(inv.amount ?? "0") || 0;
    const statusLabel = STATUS_LABEL[inv.status] ?? inv.status;
    msg += `<b>${i + 1}.</b> ${statusLabel} — <b>${dueFmt}</b>\n`;
    msg += `   💰 ${fmtBRL(principal)}\n\n`;
  });
  msg += `<i>Para detalhes financeiros, escolha a opção 2 (Extrato).</i>`;
  await sendTelegram(token, chatId, msg);
}

function calcClientTotals(invoices: Array<typeof invoicesTable.$inferSelect>) {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  let totalAmount = 0;
  let jurosAmount = 0;

  for (const inv of invoices) {
    if (inv.status === "paid") continue;
    const due = inv.dueDate ? new Date(inv.dueDate + "T00:00:00Z") : null;
    const daysLate = inv.status === "overdue" && due
      ? Math.max(0, Math.floor((today.getTime() - due.getTime()) / 86_400_000)) : 0;
    const monthsLate = calcMonthsLate(inv.dueDate, inv.recurrence);
    const principal = parseFloat(inv.amount ?? "0") || 0;
    const multa     = (parseFloat(inv.lateFee ?? "0") || 0) * billableLateDays(daysLate);
    const jurosMes  = (principal * (parseFloat(inv.interestRate ?? "0") || 0)) / 100;
    const jurosTotal = jurosMes * monthsLate;
    const extra = multa + (monthsLate > 0 ? jurosTotal : 0);
    totalAmount += principal + extra;
    // Fatura recorrente sempre tem ao menos 1 ciclo de juros pra oferecer como opção
    // "somente juros", mesmo em dia — é assim que o empréstimo funciona (paga o juros
    // do mês; o principal só quita quando o cliente escolhe "quitação total" de
    // propósito). "totalAmount" não muda — quitação continua sendo só o principal (+
    // atraso, se houver); isso só afeta se a opção "2 — somente juros" é oferecida.
    const isRecurring = !!inv.recurrence && inv.recurrence !== "none";
    const jurosPeriods = isRecurring ? Math.max(1, monthsLate) : monthsLate;
    jurosAmount += multa + jurosMes * jurosPeriods;
  }
  return { totalAmount, jurosAmount };
}

async function sendClientExtrato(token: string, chatId: number, clientId: number, clientName: string): Promise<void> {
  const invoices = await db.select().from(invoicesTable)
    .where(and(eq(invoicesTable.clientId, clientId), ne(invoicesTable.status, "paid")))
    .orderBy(invoicesTable.dueDate);

  if (invoices.length === 0) {
    await sendTelegram(token, chatId, `✅ <b>${clientName}</b>, você não possui cobranças em aberto!`);
    return;
  }

  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  let msg = `📊 <b>Extrato — ${clientName}</b>\n\n`;
  const { totalAmount } = calcClientTotals(invoices);

  for (const inv of invoices) {
    const due = inv.dueDate ? new Date(inv.dueDate + "T00:00:00Z") : null;
    const daysLate = inv.status === "overdue" && due
      ? Math.max(0, Math.floor((today.getTime() - due.getTime()) / 86_400_000)) : 0;
    const monthsLate = calcMonthsLate(inv.dueDate, inv.recurrence);
    const principal = parseFloat(inv.amount ?? "0") || 0;
    const multa     = (parseFloat(inv.lateFee ?? "0") || 0) * billableLateDays(daysLate);
    const jurosMes  = (principal * (parseFloat(inv.interestRate ?? "0") || 0)) / 100;
    const jurosTotal = jurosMes * monthsLate;
    const total = principal + multa + (monthsLate > 0 ? jurosTotal : 0);
    // Fatura recorrente sempre tem ao menos 1 ciclo de juros a exibir, mesmo em dia
    // (o cliente pode querer adiantar) — mesmo ajuste já aplicado em calcClientTotals
    // (menu de pagamento). Sem isso, o extrato omitia a linha de juros inteira numa
    // fatura ainda não vencida, porque monthsLate é 0 antes do vencimento (achado
    // real: Danilo, contrato #46, em dia, extrato não mostrava o juros de R$150).
    const isRecurring  = !!inv.recurrence && inv.recurrence !== "none";
    const jurosPeriods = isRecurring ? Math.max(1, monthsLate) : monthsLate;
    const jurosDisplay = jurosMes * jurosPeriods;
    const dueFmt = due ? due.toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "—";
    msg += `${STATUS_LABEL[inv.status] ?? inv.status} — venc. <b>${dueFmt}</b>\n`;
    msg += `💰 Principal: ${fmtBRL(principal)}`;
    if (daysLate > 0) {
      msg += `\n📅 ${daysLate} dias em atraso (${monthsLate} ${periodLabel(inv.recurrence, monthsLate)})`;
      if (multa > 0) msg += `\n⚠️ Multa: ${fmtBRL(multa)}`;
    }
    if (jurosDisplay > 0) msg += jurosPeriods > 1
      ? `\n📈 Juros: ${fmtBRL(jurosMes)}/${periodLabel(inv.recurrence, 1)} × ${jurosPeriods} = ${fmtBRL(jurosDisplay)}`
      : `\n📈 Juros: ${fmtBRL(jurosDisplay)}`;
    msg += `\n💸 Total: <b>${fmtBRL(total)}</b>\n\n`;
  }
  msg += `━━━━━━━━━━━━━━━━━━━━\n💸 <b>Total em aberto: ${fmtBRL(totalAmount)}</b>\n\nDigite <b>3</b> para ver a opção de pagamento.`;
  await sendTelegram(token, chatId, msg);
}

async function sendClientPaymentOptions(
  token: string, chatId: number,
  clientId: number, clientName: string, companyId: number,
): Promise<void> {
  const [company] = await db.select({
    pixKey: companiesTable.pixKey, pixKeyType: companiesTable.pixKeyType,
    pixRecipientName: companiesTable.pixRecipientName, pixBankName: companiesTable.pixBankName,
  }).from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);

  if (!company?.pixKey) {
    await sendTelegram(token, chatId,
      `ℹ️ A chave PIX ainda não foi configurada pela empresa.\nEntre em contato diretamente para efetuar o pagamento.`);
    return;
  }

  const invoices = await db.select().from(invoicesTable)
    .where(and(eq(invoicesTable.clientId, clientId), ne(invoicesTable.status, "paid")))
    .orderBy(invoicesTable.dueDate);

  if (invoices.length === 0) {
    await sendTelegram(token, chatId, `✅ <b>${clientName}</b>, você não possui cobranças em aberto!`);
    return;
  }

  // Mais de 1 contrato → pede pra escolher qual pagar, em vez de somar tudo num valor
  // só (sem isso, a confirmação do admin não sabe em qual fatura creditar o pagamento
  // — achado real: Roberta tinha 2 contratos recorrentes e o juro pago em um deles
  // acabava creditado no outro por engano; ver nota em wapy_yes).
  if (invoices.length > 1) {
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    let msg = `💳 <b>Pagamento — ${clientName}</b>\n\nVocê tem <b>${invoices.length}</b> contratos em aberto.\nEscolha qual deseja quitar:\n\n`;
    invoices.forEach((inv, i) => {
      const { totalAmount: invTotal } = calcClientTotals([inv]);
      const due = inv.dueDate ? new Date(inv.dueDate + "T00:00:00Z") : null;
      const dueFmt = due ? due.toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "—";
      const statusLabel = STATUS_LABEL[inv.status] ?? inv.status;
      msg += `<b>${i + 1}</b>. Contrato #${inv.id} — ${statusLabel}\n   📅 Venc: ${dueFmt} | 💸 ${fmtBRL(invTotal)}\n\n`;
    });
    msg += `<i>Digite o número (1, 2, 3...) do contrato que deseja pagar.</i>`;
    await sendTelegram(token, chatId, msg);
    conversations.set(chatId, {
      step: "cl_select_invoice_payment",
      isClientFlow: true,
      companyIdFilter: companyId,
      cl_clientId: clientId,
      cl_clientName: clientName,
      cl_invoices: invoices,
    });
    return;
  }

  await sendClientPaymentForInvoice(token, chatId, invoices[0], clientName, companyId, company);
}

async function sendClientPaymentForInvoice(
  token: string, chatId: number,
  inv: typeof invoicesTable.$inferSelect, clientName: string, companyId: number,
  company: { pixKey: string | null; pixKeyType: string | null; pixRecipientName: string | null; pixBankName: string | null },
): Promise<void> {
  const { totalAmount, jurosAmount } = calcClientTotals([inv]);
  const hasOverdue = inv.status === "overdue";

  let msg = `💳 <b>Pagamento — ${clientName}</b>\n`;
  msg += `📋 Contrato #${inv.id}\n\n`;
  msg += `💸 Valor total: <b>${fmtBRL(totalAmount)}</b>\n`;
  // Oferece a escolha sempre que houver juros a cobrar, vencida ou não — fatura
  // recorrente em dia também tem o juros do ciclo como opção válida (é o modelo do
  // empréstimo). Antes só oferecia quando já vencida, então uma fatura em dia ia
  // direto pro "pague o total" sem alternativa.
  if (jurosAmount > 0) {
    const jurosLabel = hasOverdue ? "Somente juros + multas" : "Somente juros do mês";
    msg += `📈 ${jurosLabel}: <b>${fmtBRL(jurosAmount)}</b>\n`;
    msg += `\nComo deseja efetuar o pagamento?\n\n`;
    msg += `<b>1</b> — Quitar valor total (${fmtBRL(totalAmount)})\n`;
    msg += `<b>2</b> — Pagar ${hasOverdue ? "somente juros + taxas de atraso" : "somente o juros do mês"} (${fmtBRL(jurosAmount)})\n\n`;
    msg += `<i>Responda com 1 ou 2.</i>`;

    conversations.set(chatId, {
      step: "cl_payment_type",
      isClientFlow: true,
      companyIdFilter: companyId,
      cl_clientId: inv.clientId,
      cl_clientName: clientName,
      cl_totalAmount: totalAmount,
      cl_jurosAmount: jurosAmount,
      cl_invoiceId: inv.id,
    });
    await sendTelegram(token, chatId, msg);
  } else {
    msg += showPixDetails(company, totalAmount);
    msg += `\n\nApós realizar o pagamento, envie o comprovante aqui (foto ou PDF). 📎`;
    await sendTelegram(token, chatId, msg);
    conversations.set(chatId, {
      step: "cl_await_comprovante",
      isClientFlow: true,
      companyIdFilter: companyId,
      cl_clientId: inv.clientId,
      cl_clientName: clientName,
      cl_totalAmount: totalAmount,
      cl_invoiceId: inv.id,
    });
  }
}

function showPixDetails(
  company: { pixKey: string | null; pixKeyType: string | null; pixRecipientName: string | null; pixBankName: string | null },
  amount: number,
): string {
  const pixTypeLabel: Record<string, string> = {
    cpf: "CPF", cnpj: "CNPJ", email: "E-mail", telefone: "Telefone", aleatoria: "Chave Aleatória",
  };
  let msg = `\n`;
  if (company.pixRecipientName) msg += `👤 Recebedor: <b>${company.pixRecipientName}</b>\n`;
  if (company.pixBankName)      msg += `🏦 Banco: ${company.pixBankName}\n`;
  msg += `🔑 Chave PIX (${pixTypeLabel[company.pixKeyType ?? ""] ?? "PIX"}): <code>${company.pixKey}</code>\n`;
  msg += `💸 Valor: <b>${fmtBRL(amount)}</b>`;
  return msg;
}

async function handleClientStep(
  token: string, chatId: number, text: string,
  state: ConvState, companyId: number, companyChatId?: string,
): Promise<void> {
  const input = text.trim();

  if (input === "/cancelar" || input.toLowerCase() === "cancelar") {
    conversations.delete(chatId);
    await sendTelegram(token, chatId, `Operação cancelada.\n\nDigite <b>menu</b> para voltar ao início.`);
    return;
  }

  switch (state.step) {

    case "cl_menu": {
      if (input !== "1" && input !== "2" && input !== "3") {
        await sendTelegram(token, chatId, `❌ Opção inválida. Digite <b>1</b>, <b>2</b> ou <b>3</b>:`);
        return;
      }
      conversations.delete(chatId);

      const [linked] = await db.select().from(clientsTable)
        .where(and(eq(clientsTable.companyId, companyId), eq(clientsTable.telegramChatId, String(chatId)))).limit(1);

      const action: ConvState["cl_action"] = input === "1" ? "contratos" : input === "2" ? "extrato" : "pagar";

      if (linked) {
        if (action === "contratos")       await sendClientContratos(token, chatId, linked.id, linked.name);
        else if (action === "extrato")    await sendClientExtrato(token, chatId, linked.id, linked.name);
        else                              await sendClientPaymentOptions(token, chatId, linked.id, linked.name, companyId);
      } else {
        conversations.set(chatId, { step: "cl_identify", isClientFlow: true, companyIdFilter: companyId, cl_action: action });
        await sendTelegram(token, chatId,
          `🔍 Para continuar, informe seu <b>CPF</b> ou <b>nome completo</b> cadastrado:`);
      }
      break;
    }

    case "cl_identify": {
      const digits = input.replace(/\D/g, "");
      const byDoc = digits.length >= 11
        ? await db.select().from(clientsTable)
            .where(and(eq(clientsTable.companyId, companyId), eq(clientsTable.document, digits))).limit(5)
        : [];

      const byName = byDoc.length === 0
        ? await db.select().from(clientsTable)
            .where(and(eq(clientsTable.companyId, companyId), ilike(clientsTable.name, `%${input}%`))).limit(10)
        : [];

      const candidates = byDoc.length > 0 ? byDoc : byName;

      if (candidates.length === 0) {
        await sendTelegram(token, chatId,
          `❌ Não encontrei nenhum cliente com essas informações.\n\nTente novamente com CPF ou nome completo, ou envie uma mensagem para falar com nossa equipe.`);
        conversations.delete(chatId);
        return;
      }

      if (candidates.length > 1) {
        let msg = `🔍 Encontrei <b>${candidates.length} clientes</b> com esse nome. Informe seu <b>CPF</b> para confirmar:\n\n`;
        candidates.forEach((c) => msg += `• ${c.name}\n`);
        conversations.set(chatId, {
          step: "cl_identify_multi", isClientFlow: true, companyIdFilter: companyId,
          cl_action: state.cl_action,
          cl_matchedClients: candidates.map(c => ({ id: c.id, name: c.name, document: c.document })),
        });
        await sendTelegram(token, chatId, msg);
        return;
      }

      const client = candidates[0];
      if (!client.telegramChatId) {
        await db.update(clientsTable).set({ telegramChatId: String(chatId) }).where(eq(clientsTable.id, client.id));
      }
      conversations.delete(chatId);

      const action = state.cl_action;
      if (action === "contratos")    await sendClientContratos(token, chatId, client.id, client.name);
      else if (action === "extrato") await sendClientExtrato(token, chatId, client.id, client.name);
      else                           await sendClientPaymentOptions(token, chatId, client.id, client.name, companyId);
      break;
    }

    case "cl_identify_multi": {
      const digits = input.replace(/\D/g, "");
      const matched = (state.cl_matchedClients ?? []).find(c => (c.document ?? "").replace(/\D/g, "") === digits);
      if (!matched) {
        await sendTelegram(token, chatId, `❌ CPF não corresponde a nenhum dos clientes listados. Tente novamente ou envie uma mensagem para nossa equipe.`);
        conversations.delete(chatId);
        return;
      }
      const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, matched.id)).limit(1);
      if (!client) { conversations.delete(chatId); return; }
      if (!client.telegramChatId) {
        await db.update(clientsTable).set({ telegramChatId: String(chatId) }).where(eq(clientsTable.id, client.id));
      }
      conversations.delete(chatId);

      const action = state.cl_action;
      if (action === "contratos")    await sendClientContratos(token, chatId, client.id, client.name);
      else if (action === "extrato") await sendClientExtrato(token, chatId, client.id, client.name);
      else                           await sendClientPaymentOptions(token, chatId, client.id, client.name, companyId);
      break;
    }

    case "cl_select_invoice_payment": {
      const invs = state.cl_invoices ?? [];
      const idx = parseInt(input) - 1;
      if (isNaN(idx) || idx < 0 || idx >= invs.length) {
        await sendTelegram(token, chatId, `❌ Número inválido. Digite um número entre 1 e ${invs.length}:`);
        return;
      }
      conversations.delete(chatId);
      const [company] = await db.select({
        pixKey: companiesTable.pixKey, pixKeyType: companiesTable.pixKeyType,
        pixRecipientName: companiesTable.pixRecipientName, pixBankName: companiesTable.pixBankName,
      }).from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);
      if (!company?.pixKey) {
        await sendTelegram(token, chatId, `ℹ️ Chave PIX não configurada. Entre em contato.`);
        return;
      }
      await sendClientPaymentForInvoice(token, chatId, invs[idx], state.cl_clientName ?? "—", companyId, company);
      break;
    }

    case "cl_payment_type": {
      if (input !== "1" && input !== "2") {
        await sendTelegram(token, chatId, `❌ Digite <b>1</b> para total ou <b>2</b> para juros/multas:`);
        return;
      }

      const amount = input === "1" ? (state.cl_totalAmount ?? 0) : (state.cl_jurosAmount ?? 0);
      conversations.delete(chatId);

      const [company] = await db.select({
        pixKey: companiesTable.pixKey, pixKeyType: companiesTable.pixKeyType,
        pixRecipientName: companiesTable.pixRecipientName, pixBankName: companiesTable.pixBankName,
      }).from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);

      const label = input === "1" ? "Quitação Total" : "Juros + Taxas de Atraso";
      let msg = `💳 <b>${label} — ${state.cl_clientName}</b>`;
      msg += showPixDetails(company ?? {}, amount);
      msg += `\n\nApós realizar o pagamento, envie o comprovante aqui (foto ou PDF). 📎`;
      await sendTelegram(token, chatId, msg);
      // Mantém estado esperando comprovante — grava o valor e o tipo (total/juros)
      // efetivamente escolhidos, para o admin-confirm não precisar adivinhar depois.
      state.step = "cl_await_comprovante";
      state.cl_totalAmount = amount;
      state.cl_paymentType = input === "1" ? "total" : "juros";
      conversations.set(chatId, state);
      break;
    }

    case "cl_await_comprovante":
      await sendTelegram(token, chatId, `⏳ Aguardando seu comprovante. Envie uma foto ou arquivo PDF.`);
      break;

    default:
      conversations.delete(chatId);
  }
}

async function resolveSingleCompany(token: string, chatId: number): Promise<number | undefined> {
  const companies = await db.select({ id: companiesTable.id }).from(companiesTable);
  if (companies.length === 1) return companies[0].id;
  if (companies.length === 0) {
    await sendTelegram(token, chatId, "❌ Nenhuma empresa cadastrada.");
  } else {
    await sendTelegram(token, chatId, "❌ Bot admin com múltiplas empresas — use o bot da empresa específica.");
  }
  return undefined;
}

async function pollBot(token: string, companyId: number | undefined, label: string, companyChatId?: string, signal?: AbortSignal): Promise<void> {
  let offset = 0;

  while (!signal?.aborted) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${token}/getUpdates?timeout=30&offset=${offset}&allowed_updates=%5B%22message%22%2C%22callback_query%22%5D`,
        { signal: signal ?? undefined },
      );

      if (!res.ok) {
        await new Promise((r) => setTimeout(r, 5_000));
        continue;
      }

      const data = (await res.json()) as { ok: boolean; result?: any[] };
      if (!data.ok || !data.result) {
        await new Promise((r) => setTimeout(r, 5_000));
        continue;
      }

      for (const update of data.result) {
        offset = update.update_id + 1;

        // ── CALLBACK QUERY (botões inline) ─────────────────────────────────────
        if (update.callback_query) {
          const cbq      = update.callback_query;
          const cbData   = (cbq.data ?? "") as string;
          const cbChatId = cbq.message?.chat?.id as number | undefined;
          const cbMsgId  = cbq.message?.message_id as number | undefined;
          await answerCallback(token, cbq.id, "");

          if (cbData.startsWith("wapy_yes:") && cbChatId && cbMsgId) {
            const payId = cbData.slice("wapy_yes:".length);
            const pending = await removePendingPayment(payId);

            // Atualiza faturas no banco e lança no fluxo de caixa
            let paidCount = 0;
            if (pending?.clientId && pending?.companyId) {
              const cfCompanyId = pending.companyId;
              const valorPago = pending.totalAmount ?? 0;

              // Busca faturas em aberto do cliente para fechar apenas as que cabem no valor pago
              const allOpenInvoices = await db.select().from(invoicesTable)
                .where(and(eq(invoicesTable.clientId, pending.clientId), ne(invoicesTable.status, "paid")))
                .orderBy(invoicesTable.dueDate);

              // Quando o cliente escolheu explicitamente qual contrato pagar (fluxo de
              // pagamento por WhatsApp/Telegram guarda cl_invoiceId de ponta a ponta),
              // restringe à fatura selecionada em vez de "adivinhar" pela primeira fatura
              // recorrente da lista — achado real: Roberta (cliente 26) tinha 2 contratos
              // recorrentes abertos, pagou o juro do #45, mas o sistema creditou no #74
              // (que vencia antes na ordenação) porque nada aqui sabia qual fatura era.
              // Sem correspondência (payId antigo, de antes desse campo existir), cai no
              // comportamento heurístico anterior como fallback.
              const openInvoices = pending.invoiceId
                ? allOpenInvoices.filter(inv => inv.id === pending.invoiceId)
                : allOpenInvoices;

              // Primeiro verifica se o valor pago corresponde a juros+multa de uma fatura recorrente
              // (deve rodar ANTES do filtro de principal para evitar falso "Pago")
              let jurosAdvanced = false;
              if (valorPago > 0 && pending.paymentType !== "total") {
                const todayAdv = new Date(); todayAdv.setUTCHours(0, 0, 0, 0);
                const todayStr = todayAdv.toISOString().split("T")[0];
                for (const inv of openInvoices) {
                  if (!inv.recurrence || inv.recurrence === "none") continue;
                  const due = inv.dueDate ? new Date(inv.dueDate + "T00:00:00Z") : null;
                  const dl  = inv.status === "overdue" && due
                    ? Math.max(0, Math.floor((todayAdv.getTime() - due.getTime()) / 86_400_000)) : 0;
                  const p    = parseFloat(inv.amount ?? "0") || 0;
                  const fee  = parseFloat(inv.lateFee ?? "0") || 0;
                  const rate = parseFloat(inv.interestRate ?? "0") || 0;
                  const pd   = calcMonthsLate(inv.dueDate, inv.recurrence);
                  const encargos = fee * dl + (p * rate / 100) * (pd || 1);
                  // Valor deve bater dentro de ±15% dos encargos E ser menor que 80% do principal
                  // (evita confundir pagamento parcial de principal com juros)
                  const encargosMatch = encargos > 0 && valorPago >= encargos * 0.85 && valorPago <= encargos * 1.15 && valorPago < p * 0.8;
                  // Prioridade: a escolha explícita do cliente no menu (cl_payment_type "somente
                  // juros") — agora sempre oferecida quando a fatura é recorrente, vencida ou não
                  // (ver calcClientTotals/calcClientTotalsWA). "encargosMatch" fica só como
                  // fallback pra pagamentos pendentes antigos sem esse campo. Removido o antigo
                  // "valor pago ≈ valor de face" como sinal de juros: isso está ERRADO — pagar o
                  // valor de face de uma fatura recorrente é exatamente o que é uma quitação total
                  // legítima (caso real: Walisson pagou os R$300 de face da fatura #63 e QUITOU de
                  // verdade; tratar isso como juros teria sido um erro na direção oposta ao do
                  // Wesley, que pagou só os R$120 de juros mas o sistema assumiu R$400 de intenção
                  // porque a fatura ainda não vencida nunca ofereceu a escolha).
                  if (pending.paymentType === "juros" || encargosMatch) {
                    // Pagamento de juros/multa detectado → avança recorrência
                    await db.update(debtsTable).set({ status: "closed" })
                      .where(and(eq(debtsTable.invoiceId, inv.id), eq(debtsTable.status, "open")));
                    const base = new Date((inv.dueDate ?? todayStr) + "T12:00:00Z");
                    if (inv.recurrence === "monthly")        base.setUTCMonth(base.getUTCMonth() + 1);
                    else if (inv.recurrence === "weekly")    base.setUTCDate(base.getUTCDate() + 7);
                    else if (inv.recurrence === "biweekly")  base.setUTCDate(base.getUTCDate() + 14);
                    else if (inv.recurrence === "daily")     base.setUTCDate(base.getUTCDate() + 1);
                    const newDueDate = base.toISOString().split("T")[0];
                    const newStatus  = newDueDate > todayStr ? "current" : "overdue";
                    await db.update(invoicesTable)
                      .set({ dueDate: newDueDate, status: newStatus, interestPaid: false })
                      .where(eq(invoicesTable.id, inv.id));
                    if (newStatus === "overdue") {
                      const ex = await db.select().from(debtsTable)
                        .where(and(eq(debtsTable.invoiceId, inv.id), eq(debtsTable.status, "open")));
                      if (ex.length === 0) {
                        await db.insert(debtsTable).values({
                          companyId: cfCompanyId, clientId: pending.clientId, invoiceId: inv.id, status: "open", daysOverdue: 0,
                        });
                      }
                    }
                    // Lança no caixa o juros calculado pela fórmula da própria fatura (taxa ×
                    // principal), NÃO o valor do pagamento pendente — esse reflete "quanto a
                    // fatura pede", que numa fatura ainda não vencida é o valor de face inteiro,
                    // não o juros do ciclo (bug real: Wesley pagou R$120 de juros de uma fatura
                    // de R$400 e o caixa registrou R$400 — encargos aqui já dá os R$120 certos).
                    const jurosValue = encargos > 0 ? encargos : valorPago;
                    await db.insert(cashFlowTable).values({
                      companyId: cfCompanyId, type: "income",
                      amount: String(jurosValue.toFixed(2)),
                      description: `Juros/multa via WhatsApp — ${pending.clientName} (#${inv.id})`,
                      category: "juros", date: new Date(),
                    });
                    jurosAdvanced = true;
                    paidCount = 1;
                    break;
                  }
                }
              }

              // Marca apenas as faturas cujo principal cabe no valor pago (tolerância 10%)
              let toMark: typeof openInvoices = [];
              if (!jurosAdvanced) {
                let remaining = valorPago;
                toMark = valorPago > 0
                  ? openInvoices.filter(inv => { const v = parseFloat(inv.amount ?? "0") || 0; if (remaining >= v * 0.9) { remaining -= v; return true; } return false; })
                  : openInvoices; // sem valor definido → marca todas

                for (const inv of toMark) {
                  await db.update(invoicesTable).set({ status: "paid", interestPaid: true }).where(eq(invoicesTable.id, inv.id));
                  if (inv.status === "overdue") {
                    await db.update(debtsTable).set({ status: "closed" })
                      .where(and(eq(debtsTable.invoiceId, inv.id), eq(debtsTable.status, "open")));
                  }
                }
              }

              // Registra no cashflow quando admin confirma pagamento de principal
              if (!jurosAdvanced && (valorPago > 0 || toMark.length > 0)) {
                const valorFinal = valorPago > 0 ? valorPago
                  : toMark.reduce((s, inv) => s + (parseFloat(inv.amount ?? "0") || 0), 0);
                const descExtra = toMark.length === 0 ? " (fatura pendente — verificar manualmente)" : "";
                await db.insert(cashFlowTable).values({
                  companyId: cfCompanyId, type: "income",
                  amount: String(valorFinal.toFixed(2)),
                  description: `Quitação via WhatsApp — ${pending.clientName}${descExtra}`,
                  category: "cobranças", date: new Date(),
                });
              }

              paidCount = toMark.length + (jurosAdvanced ? 1 : 0);
            }

            // Cliente pode ter vindo do WhatsApp (notifica via sendWA) ou do bot direto no
            // Telegram (notifica de volta no mesmo chat) — nunca os dois ao mesmo tempo.
            const viaTelegram = pending?.telegramClientChatId != null;
            const waCfgYes = !viaTelegram && pending ? (pending.instance
              ? { ...buildWaConfig()!, instance: pending.instance, companyId: pending.companyId }
              : buildWaConfig()) : null;
            await Promise.all([
              editMsgRemoveButtons(token, cbChatId, cbMsgId,
                `✅ <b>Pagamento confirmado!</b> ${paidCount > 0 ? `${paidCount} fatura(s) de ` : ""}${pending?.clientName ?? "Cliente"} marcadas como pagas e notificado.`),
              viaTelegram
                ? sendTelegram(token, pending!.telegramClientChatId!,
                    `✅ <b>Pagamento confirmado!</b>\n\nOlá, ${pending!.clientName}! 😊\n\nSeu pagamento foi recebido e confirmado com sucesso! 🎉\n\nAgradecemos pela sua confiança na Lastro Capital. 💚`)
                : waCfgYes && pending
                ? sendWA(waCfgYes, pending.phone,
                    `🏦 *LASTRO CAPITAL*\n━━━━━━━━━━━━━━━━━━━━\n\n✅ *Pagamento Confirmado!*\n\nOlá, ${pending.clientName}! 😊\n\nSeu pagamento foi recebido e *confirmado com sucesso!* 🎉\n\nAgradecemos pela sua confiança na *Lastro Capital*. 💚\n\nEm caso de dúvidas, estamos à disposição.`)
                : Promise.resolve(),
            ]);

          } else if (cbData.startsWith("wapy_no:") && cbChatId && cbMsgId) {
            const payId = cbData.slice("wapy_no:".length);
            const pending = await removePendingPayment(payId);
            const viaTelegram = pending?.telegramClientChatId != null;
            const waCfgNo = !viaTelegram && pending ? (pending.instance
              ? { ...buildWaConfig()!, instance: pending.instance, companyId: pending.companyId }
              : buildWaConfig()) : null;
            await Promise.all([
              editMsgRemoveButtons(token, cbChatId, cbMsgId,
                `❌ <b>Pagamento recusado.</b> ${pending?.clientName ?? "Cliente"} foi notificado.`),
              viaTelegram
                ? sendTelegram(token, pending!.telegramClientChatId!,
                    `⚠️ <b>Atenção</b>\n\nOlá, ${pending!.clientName}!\n\nNão conseguimos identificar o seu pagamento no sistema.\n\nPor favor, entre em contato com nossa administração para verificar e regularizar sua situação.`)
                : waCfgNo && pending
                ? sendWA(waCfgNo, pending.phone,
                    `🏦 *LASTRO CAPITAL*\n━━━━━━━━━━━━━━━━━━━━\n\n⚠️ *Atenção*\n\nOlá, ${pending.clientName}!\n\nNão conseguimos identificar o seu pagamento no sistema.\n\nPor favor, entre em contato com nossa *administração* para verificar e regularizar sua situação.\n\nEstamos aqui para te ajudar. 💚`)
                : Promise.resolve(),
            ]);
          }
          continue;
        }

        const text   = (update.message?.text ?? "") as string;
        const chatId = update.message?.chat?.id as number | undefined;
        if (!chatId) continue;

        const hasMedia = !!(update.message?.photo || update.message?.document);

        // Comprovante enviado por cliente no estado cl_await_comprovante
        if (hasMedia && companyId && companyChatId && String(chatId) !== companyChatId) {
          const activeMediaConv = conversations.get(chatId);
          if (activeMediaConv?.step === "cl_await_comprovante") {
            const clId   = activeMediaConv.cl_clientId;
            const clName = activeMediaConv.cl_clientName ?? "cliente";
            conversations.delete(chatId);

            // Agradece o cliente
            await sendTelegram(token, chatId,
              `✅ Comprovante recebido!\n\nSeu pagamento está sendo processado. Em breve você receberá a confirmação. 🙏`);

            // Encaminha o comprovante ao admin
            await forwardTelegramMessage(token, companyChatId, chatId, update.message.message_id);

            // Usa o mesmo mecanismo de confirmação do WhatsApp (payId persistido em
            // wa_pending_payments) em vez do antigo "pay_yes:clientId:chatId" — aquele
            // fluxo não sabia quanto o cliente pagou nem se era quitação ou só juros, e
            // acabava marcando TODAS as faturas em aberto como pagas ao apertar confirmar.
            const [clientRow] = clId
              ? await db.select({ phone: clientsTable.phone }).from(clientsTable).where(eq(clientsTable.id, clId)).limit(1)
              : [];
            const payId = `tgpay_${Date.now()}`;
            await savePendingPayment(payId, {
              phone: clientRow?.phone ?? "",
              clientName: clName,
              clientId: clId,
              totalAmount: activeMediaConv.cl_totalAmount,
              paymentType: activeMediaConv.cl_paymentType,
              instance: buildWaConfig()?.instance ?? "",
              companyId,
              telegramClientChatId: chatId,
              invoiceId: activeMediaConv.cl_invoiceId,
            });

            // Envia botões de confirmação ao admin
            await sendTelegramWithButtons(token, companyChatId,
              `📎 <b>Comprovante recebido</b> de <b>${clName}</b>!\n\nDeseja confirmar o pagamento?`,
              [
                { text: "✅ Confirmar pagamento", callback_data: `wapy_yes:${payId}` },
                { text: "❌ Rejeitar",            callback_data: `wapy_no:${payId}` },
              ]
            );
            continue;
          }
          // Mídia fora de fluxo — ignora
          continue;
        }

        if (!text) continue;

        // Determina se é modo cliente (bot de empresa + chatId diferente do admin)
        const isClientMode = !!companyId && !!companyChatId && String(chatId) !== companyChatId;

        // Conversa em andamento — rota para o handler correto
        const activeConv = conversations.get(chatId);
        if (activeConv) {
          if (isClientMode || activeConv.isClientFlow) {
            await handleClientStep(token, chatId, text, activeConv, companyId ?? activeConv.companyIdFilter ?? 0, companyChatId);
          } else {
            await handleConversationStep(token, chatId, text, activeConv);
          }
          continue;
        }

        const rawCmd = text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
        const isVencidos = rawCmd === "/vencidos" || rawCmd === "/vencido" ||
          rawCmd.startsWith("/vencidos") || rawCmd.startsWith("/vencido");

        // ── MODO CLIENTE ─────────────────────────────────────────────────────
        if (isClientMode) {
          if (rawCmd === "/desvincular") {
            const updated = await db.update(clientsTable)
              .set({ telegramChatId: null })
              .where(eq(clientsTable.telegramChatId, String(chatId)))
              .returning({ name: clientsTable.name });
            await sendTelegram(token, chatId, updated.length > 0
              ? `🔕 <b>${updated[0].name}</b>, seu Telegram foi desvinculado.`
              : `ℹ️ Nenhum vínculo encontrado para este chat.`);
          } else if (rawCmd === "/start" || rawCmd === "/ajuda" || rawCmd === "/help" || text.trim().toLowerCase() === "menu") {
            const menuMsg = await buildClientMenuMsg(companyId!);
            await sendTelegram(token, chatId, menuMsg);
            conversations.set(chatId, { step: "cl_menu", isClientFlow: true, companyIdFilter: companyId });
          } else if (text.trim() === "1" || text.trim() === "2" || text.trim() === "3") {
            // Atalho: cliente digita número direto sem passar pelo menu
            const fakeState: ConvState = { step: "cl_menu", isClientFlow: true, companyIdFilter: companyId };
            conversations.set(chatId, fakeState);
            await handleClientStep(token, chatId, text, fakeState, companyId!, companyChatId);
          } else if (rawCmd.startsWith("/")) {
            // Comando desconhecido para cliente — mostra menu
            const menuMsg = await buildClientMenuMsg(companyId!);
            await sendTelegram(token, chatId, menuMsg);
            conversations.set(chatId, { step: "cl_menu", isClientFlow: true, companyIdFilter: companyId });
          } else {
            // Texto livre — repassa para o admin e confirma ao cliente
            const [linked] = await db.select({ name: clientsTable.name, phone: clientsTable.phone })
              .from(clientsTable)
              .where(and(eq(clientsTable.companyId, companyId!), eq(clientsTable.telegramChatId, String(chatId)))).limit(1);
            const senderName = linked?.name ?? `Chat ${chatId}`;
            const phoneTag   = linked?.phone ? ` | ${linked.phone}` : "";
            await sendTelegram(token, companyChatId!, `💬 <b>${senderName}</b>${phoneTag}:\n${text}`);
            await sendTelegram(token, chatId, `✅ Mensagem recebida! Nossa equipe entrará em contato em breve.`);
          }
          continue;
        }

        // ── MODO ADMIN ────────────────────────────────────────────────────────
        if (rawCmd === "/ajuda" || rawCmd === "/help" || rawCmd === "/start") {
          await sendTelegram(token, chatId, AJUDA_MSG);

        } else if (rawCmd === "/vincular") {
          const cId = companyId ?? await resolveSingleCompany(token, chatId);
          if (!cId) continue;
          const rawPhone = text.trim().slice(rawCmd.length).trim();
          if (!rawPhone) {
            await sendTelegram(token, chatId, `📱 <b>Vincular cliente</b>\n\nExemplo: <code>/vincular 11999999999</code>`);
            continue;
          }
          const digits = rawPhone.replace(/\D/g, "");
          if (digits.length < 8) {
            await sendTelegram(token, chatId, `❌ Número inválido.`);
            continue;
          }
          const allClients = await db.select().from(clientsTable).where(eq(clientsTable.companyId, cId));
          const matched = allClients.find((c) => (c.phone ?? "").replace(/\D/g, "") === digits);
          if (!matched) {
            await sendTelegram(token, chatId, `❌ Número não encontrado.`);
            continue;
          }
          await db.update(clientsTable).set({ telegramChatId: String(chatId) }).where(eq(clientsTable.id, matched.id));
          await sendTelegram(token, chatId, `✅ <b>${matched.name}</b> vinculado com sucesso.`);

        } else if (rawCmd === "/desvincular") {
          const updated = await db.update(clientsTable)
            .set({ telegramChatId: null })
            .where(eq(clientsTable.telegramChatId, String(chatId)))
            .returning({ name: clientsTable.name });
          await sendTelegram(token, chatId, updated.length > 0
            ? `🔕 ${updated[0].name} desvinculado.`
            : `ℹ️ Nenhum vínculo encontrado.`);

        } else if (rawCmd === "/novocliente") {
          const cId = companyId ?? await resolveSingleCompany(token, chatId);
          if (!cId) return;
          conversations.set(chatId, { step: "nc_name", companyIdFilter: cId });
          await sendTelegram(token, chatId, `👤 <b>Novo Cliente</b>\n\nDigite o nome completo:\n\n<i>/cancelar para abortar</i>`);

        } else if (rawCmd === "/cobranca") {
          const cId = companyId ?? await resolveSingleCompany(token, chatId);
          if (!cId) return;
          conversations.set(chatId, { step: "client", companyIdFilter: cId });
          await sendTelegram(token, chatId, `📝 <b>Nova Cobrança</b>\n\nDigite o nome do cliente:\n\n<i>/cancelar para abortar</i>`);

        } else if (rawCmd === "/quitacao") {
          const cId = companyId ?? await resolveSingleCompany(token, chatId);
          if (!cId) return;
          conversations.set(chatId, { step: "qt_client", companyIdFilter: cId });
          await sendTelegram(token, chatId, `💳 <b>Registrar Pagamento</b>\n\nDigite o nome do cliente:\n\n<i>/cancelar para abortar</i>`);

        } else if (rawCmd === "/resumo") {
          const msg = await buildResumoMessage(companyId);
          await sendTelegram(token, chatId, msg);

        } else if (rawCmd === "/contrato" || rawCmd === "/detalhes") {
          const idStr = text.trim().slice(rawCmd.length).trim().replace(/^#/, "");
          const id = parseInt(idStr, 10);
          if (isNaN(id) || id <= 0) {
            await sendTelegram(token, chatId, `❌ Informe o número do contrato.\nExemplo: <code>/contrato 27</code>`);
          } else {
            const conds: any[] = [eq(invoicesTable.id, id)];
            if (companyId) conds.push(eq(invoicesTable.companyId, companyId));
            const [row] = await db
              .select({ invoice: invoicesTable, clientName: clientsTable.name, clientPhone: clientsTable.phone, clientRef: clientsTable.referralSource })
              .from(invoicesTable)
              .leftJoin(clientsTable, eq(invoicesTable.clientId, clientsTable.id))
              .where(and(...conds));
            if (!row) {
              await sendTelegram(token, chatId, `❌ Contrato #${id} não encontrado.`);
            } else {
              const msg = buildInvoiceDetail(row.invoice, row.clientName ?? "—", row.clientPhone ?? undefined, row.clientRef ?? undefined);
              await sendTelegram(token, chatId, msg);
            }
          }

        } else if (rawCmd === "/cliente") {
          const clientName = text.trim().slice(rawCmd.length).trim();
          if (!clientName) {
            await sendTelegram(token, chatId, `❌ Informe o nome do cliente.\nExemplo: <code>/cliente Lucas</code>`);
          } else {
            const msg = await buildClientMessage(clientName, companyId);
            await sendTelegram(token, chatId, msg);
          }

        } else if (isVencidos) {
          const prefix = rawCmd.startsWith("/vencidos") ? "/vencidos" : "/vencido";
          const inlineFilter = rawCmd.slice(prefix.length).trim();
          const spaceFilter  = text.trim().slice(rawCmd.length).trim();
          const referral     = (inlineFilter || spaceFilter) || undefined;
          const msg = await buildVencidosMessage(companyId, referral);
          await sendTelegram(token, chatId, msg);

        } else if (rawCmd.startsWith("/") && rawCmd.length > 1) {
          const inlinePart = rawCmd.slice(1).trim();
          const spacePart  = text.trim().slice(rawCmd.length).trim();
          const clientName = (inlinePart + (spacePart ? " " + spacePart : "")).trim();
          if (clientName) {
            const clientConditions: any[] = [ilike(clientsTable.name, `%${clientName}%`)];
            if (companyId) clientConditions.push(eq(clientsTable.companyId, companyId));
            const clients = await db.select().from(clientsTable).where(and(...clientConditions)).orderBy(clientsTable.name);
            if (clients.length === 0) {
              await sendTelegram(token, chatId, `❌ Nenhum cliente encontrado com o nome <b>${clientName}</b>.`);
            } else if (clients.length === 1) {
              const client = clients[0];
              const invoices = await db.select().from(invoicesTable)
                .where(eq(invoicesTable.clientId, client.id)).orderBy(invoicesTable.dueDate);
              if (invoices.length <= 1) {
                const msg = await buildClientMessage(clientName, companyId);
                await sendTelegram(token, chatId, msg);
              } else {
                const today = new Date(); today.setUTCHours(0, 0, 0, 0);
                const phone = client.phone ? ` | ${client.phone}` : "";
                const refTag = client.referralSource && client.referralSource !== "invite_link" ? `\n🔗 Indicação: ${client.referralSource}` : "";
                const overdueCount = invoices.filter(i => i.status === "overdue").reduce((sum, i) => {
                  if (!i.dueDate) return sum + 1;
                  const dl = Math.max(0, Math.floor((today.getTime() - new Date(i.dueDate + "T00:00:00Z").getTime()) / 86_400_000));
                  return sum + Math.max(1, calcMonthsLate(i.dueDate, i.recurrence));
                }, 0);
                const overdueTag = overdueCount > 0 ? ` | ⚠️ <b>${overdueCount} parcela${overdueCount > 1 ? "s" : ""} em atraso</b>` : "";
                const header = `👤 <b>${client.name}</b>${phone}${refTag}\n📋 <b>${invoices.length} contrato${invoices.length > 1 ? "s" : ""}</b>${overdueTag} — escolha um:\n\n`;

                const NUM_EMOJI = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];
                const blocks = invoices.map((inv, i) => {
                  const due = inv.dueDate ? new Date(inv.dueDate + "T00:00:00Z") : null;
                  const dueFmt = due ? due.toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "—";
                  const principal = parseFloat(inv.amount ?? "0") || 0;
                  const feePerDay = parseFloat(inv.lateFee ?? "0") || 0;
                  const daysLate = inv.status === "overdue" && due
                    ? Math.max(0, Math.floor((today.getTime() - due.getTime()) / 86_400_000)) : 0;
                  const multa = billableLateDays(daysLate) * feePerDay;
                  const statusLabel = STATUS_LABEL[inv.status] ?? inv.status;
                  const numTag = i < NUM_EMOJI.length ? NUM_EMOJI[i] : `${i + 1}.`;

                  let block = `${numTag} <b>${statusLabel}</b> — ${dueFmt}\n`;
                  block += `💰 Principal: ${fmtBRL(principal)}`;
                  if (daysLate > 0) block += `\n⏳ ${daysLate} dias de atraso`;
                  if (multa > 0)    block += `\n⚠️ Multa: ${fmtBRL(multa)}`;
                  block += `\n\n📝 <b>Observação:</b>\n`;
                  if (inv.notes) {
                    block += inv.notes;
                    if (inv.notesUpdatedAt) {
                      const d = new Date(inv.notesUpdatedAt);
                      block += `\n<i>Atualizado em ${d.toLocaleDateString("pt-BR", { timeZone: "UTC" })} às ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })}</i>`;
                    }
                  } else {
                    block += `Nenhuma observação cadastrada.`;
                  }
                  block += `\n\n────────────────────`;
                  return block;
                });

                const footer = `\nDigite o número do contrato ou /cancelar:`;
                const MAX_LEN = 3500;

                // Grava estado antes de enviar (Telegram pode ser lento)
                conversations.set(chatId, { step: "cs_select_invoice", companyIdFilter: companyId, cs_clientName: client.name, cs_clientPhone: client.phone ?? undefined, cs_clientRef: client.referralSource ?? undefined, cs_invoices: invoices });

                let currentMsg = header;
                for (let b = 0; b < blocks.length; b++) {
                  const isLast = b === blocks.length - 1;
                  const chunk = blocks[b] + (isLast ? footer : "\n\n");
                  if (currentMsg !== header && currentMsg.length + chunk.length > MAX_LEN) {
                    await sendTelegram(token, chatId, currentMsg.trimEnd());
                    currentMsg = chunk;
                  } else {
                    currentMsg += chunk;
                  }
                }
                if (currentMsg.trim()) await sendTelegram(token, chatId, currentMsg.trimEnd());
              }
            } else {
              const msg = await buildClientMessage(clientName, companyId);
              await sendTelegram(token, chatId, msg);
            }
          }
        }
      }
    } catch (e: any) {
      if (signal?.aborted) return;
      logger.warn(`[TelegramCmd] Erro no poll (${label}): ${e.message}`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

const activeTokens = new Set<string>();

// Mapa de controllers para parar polling por empresa
const botControllers = new Map<number, AbortController>();

export function stopCompanyBotPolling(companyId: number, oldToken?: string): void {
  const ctrl = botControllers.get(companyId);
  if (ctrl) { ctrl.abort(); botControllers.delete(companyId); }
  if (oldToken) activeTokens.delete(oldToken);
}

export function startCompanyBotPolling(token: string, companyId: number, companyName: string, companyChatId?: string): void {
  const adminToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token === adminToken || activeTokens.has(token)) return;
  activeTokens.add(token);
  const ctrl = new AbortController();
  botControllers.set(companyId, ctrl);
  logger.info(`[TelegramCmd] Iniciando polling — empresa "${companyName}"`);
  pollBot(token, companyId, `empresa "${companyName}"`, companyChatId, ctrl.signal).catch(() => {});
}

export function startTelegramCommandPolling(): void {
  const adminToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!adminToken) {
    logger.warn("[TelegramCmd] TELEGRAM_BOT_TOKEN não configurado — comandos desativados");
    return;
  }

  activeTokens.add(adminToken);

  // Busca empresas antes de iniciar o polling para passar companyId e companyChatId corretos
  db.select({
    id:               companiesTable.id,
    name:             companiesTable.name,
    telegramBotToken: companiesTable.telegramBotToken,
    telegramChatId:   companiesTable.telegramChatId,
  })
    .from(companiesTable)
    .then((companies) => {
      // Se existe uma única empresa usando o mesmo token do admin,
      // passa o companyId e companyChatId para separar admin de clientes
      const sameTokenCompany = companies.find(c => c.telegramBotToken === adminToken);
      const companyId  = sameTokenCompany?.id;
      const adminChatId = sameTokenCompany?.telegramChatId
        ?? process.env.TELEGRAM_ADMIN_CHAT_ID
        ?? undefined;

      logger.info(
        `[TelegramCmd] Iniciando polling — bot admin` +
        (companyId   ? ` | empresa #${companyId}` : "") +
        (adminChatId ? ` | adminChat=${adminChatId}` : " | ⚠️ adminChatId não configurado — modo cliente inativo"),
      );
      pollBot(adminToken, companyId, "admin", adminChatId).catch(() => {});

      // Bots de empresa com tokens diferentes (setup multi-bot)
      for (const c of companies) {
        if (c.telegramBotToken && c.telegramBotToken !== adminToken) {
          startCompanyBotPolling(c.telegramBotToken, c.id, c.name ?? String(c.id), c.telegramChatId ?? undefined);
        }
      }
    })
    .catch((e) => {
      logger.warn(`[TelegramCmd] Erro ao carregar bots: ${e.message}`);
      pollBot(adminToken, undefined, "admin").catch(() => {}); // fallback sem contexto
    });
}
