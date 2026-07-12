import { db, invoicesTable, clientsTable, companiesTable, debtsTable, cashFlowTable } from "@workspace/db";
import { eq, and, ilike, ne, or, sql as drizzleSql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { monthsLate as calcMonthsLate, billableLateDays } from "./invoiceCalculator";

// ── Config ────────────────────────────────────────────────────────────────────

export interface WaConfig {
  apiUrl: string;
  apiKey: string;
  instance: string;
  adminPhone: string;   // digits only, e.g. "5511999999999"
  companyId?: number;
  companyChatId?: string; // admin phone for company-specific bot
}

// ── Conversation state (mirrors telegramCommands) ─────────────────────────────

type WaStep =
  | "client" | "select_client" | "amount" | "due_date" | "interest" | "late_fee"
  | "nc_name" | "nc_phone" | "nc_document" | "nc_referral"
  | "qt_client" | "qt_select_client" | "qt_select_invoice" | "qt_type"
  | "cs_select_invoice"
  | "cl_menu" | "cl_identify" | "cl_identify_multi" | "cl_post_contratos" | "cl_post_extrato"
  | "cl_select_invoice_payment" | "cl_payment_type" | "cl_await_comprovante";

interface WaConvState {
  step: WaStep;
  companyIdFilter?: number;
  isClientFlow?: boolean;
  clientId?: number; clientName?: string; clientCompanyId?: number;
  amount?: number; dueDate?: string; interestRate?: number; lateFee?: number;
  pendingClients?: Array<{ id: number; name: string; companyId: number; companyName: string | null }>;
  nc_name?: string; nc_phone?: string; nc_document?: string; nc_referral?: string;
  cs_clientName?: string; cs_clientPhone?: string; cs_clientRef?: string;
  cs_invoices?: Array<typeof invoicesTable.$inferSelect>;
  qt_pendingClients?: Array<{ id: number; name: string; companyId: number }>;
  qt_clientId?: number; qt_clientName?: string; qt_clientCompanyId?: number;
  qt_invoices?: Array<{
    id: number; amount: string | null; dueDate: string | null; status: string;
    interestRate: string | null; lateFee: string | null; daysLate: number | null;
    recurrence: string | null; interestPaid: boolean | null;
  }>;
  qt_invoiceIdx?: number;
  cl_action?: "contratos" | "extrato" | "pagar";
  cl_clientId?: number; cl_clientName?: string;
  cl_totalAmount?: number; cl_jurosAmount?: number; cl_paymentType?: "total" | "juros";
  cl_matchedClients?: Array<{ id: number; name: string; document: string | null }>;
  cl_invoices?: Array<typeof invoicesTable.$inferSelect>;
  cl_invoiceId?: number;
}

// Expira conversas paradas há muito tempo — evita que um fluxo abandonado
// (ex: cliente saiu no meio do pagamento e voltou a falar de outro assunto)
// continue interceptando mensagens não relacionadas indefinidamente.
const CONV_TTL_MS = 20 * 60 * 1000; // 20 minutos de inatividade
class ExpiringConvMap {
  private data = new Map<string, WaConvState>();
  private touchedAt = new Map<string, number>();
  private expired(key: string): boolean {
    const ts = this.touchedAt.get(key);
    return ts !== undefined && Date.now() - ts > CONV_TTL_MS;
  }
  set(key: string, value: WaConvState): void {
    this.data.set(key, value);
    this.touchedAt.set(key, Date.now());
  }
  get(key: string): WaConvState | undefined {
    if (this.expired(key)) { this.delete(key); return undefined; }
    return this.data.get(key);
  }
  has(key: string): boolean {
    if (this.expired(key)) { this.delete(key); return false; }
    return this.data.has(key);
  }
  delete(key: string): void {
    this.data.delete(key);
    this.touchedAt.delete(key);
  }
}
const waConversations = new ExpiringConvMap();

// Dedup: mesma mensagem pode chegar duas vezes (versão @lid + versão real phone)
const processedMsgIds = new Set<string>();
// Registra qual JID processou cada msgId — usado para cruzar @lid ↔ phone
const msgIdToJid = new Map<string, string>();
// Mapeamento @lid → JID real (WhatsApp Business / multi-device)
const jidAliases = new Map<string, string>();
// msgIds de @lid que já aguardaram timeout e serão processados como fallback
const lidFallbacks = new Set<string>();

// Divisor de dias por período, usado só pra fatiar o detalhamento visual por
// período nas mensagens (quantos dias caem em cada período) — a contagem de
// quantos períodos estão em atraso vem de calcMonthsLate (invoiceCalculator.ts),
// que usa o vencimento real em vez de dias÷30.
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

// Normaliza telefone para JID WhatsApp completo: "19999856727" → "5519999856727@s.whatsapp.net"
function normalizePhoneForWA(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("55") && digits.length >= 12) return `${digits}@s.whatsapp.net`;
  if (digits.length >= 8) return `55${digits}@s.whatsapp.net`;
  return `${digits}@s.whatsapp.net`;
}

// Carrega mapeamentos @lid do banco para memória. Executado na inicialização e a cada 30s.
let jidMappingsLoaded = false;
async function reloadJidMappings(): Promise<void> {
  try {
    const rows = await db.select({ phone: clientsTable.phone, whatsappJid: clientsTable.whatsappJid })
      .from(clientsTable)
      .where(drizzleSql`${clientsTable.whatsappJid} IS NOT NULL`);
    jidAliases.clear();
    for (const row of rows) {
      if (row.whatsappJid && row.phone) {
        jidAliases.set(row.whatsappJid, normalizePhoneForWA(row.phone));
      }
    }
    if (!jidMappingsLoaded) {
      logger.info(`[WA] ${rows.length} mapeamentos @lid carregados do banco`);
      jidMappingsLoaded = true;
    }
  } catch (e: any) {
    logger.warn(`[WA] Erro ao carregar mapeamentos @lid: ${e.message}`);
  }
}
async function ensureJidMappings(): Promise<void> {
  if (!jidMappingsLoaded) await reloadJidMappings();
}
// Loop de sincronização: recarrega contatos a cada 30s para refletir mudanças no painel
setInterval(() => { reloadJidMappings().catch(() => {}); }, 30_000);

// Persiste mapeamento @lid → telefone no banco e na memória. Retorna o JID real ou null.
export async function saveJidMapping(lidJid: string, inputPhone: string, companyId: number): Promise<string | null> {
  const realJid = normalizePhoneForWA(inputPhone);
  const last8 = inputPhone.replace(/\D/g, "").slice(-8);
  try {
    if (last8.length >= 8) {
      // Busca TODOS os clientes com esse telefone (sem limit(1)) para detectar duplicatas
      const matches = await db.select({ id: clientsTable.id, whatsappJid: clientsTable.whatsappJid })
        .from(clientsTable)
        .where(and(
          eq(clientsTable.companyId, companyId),
          drizzleSql`RIGHT(REGEXP_REPLACE(${clientsTable.phone}, '[^0-9]', '', 'g'), 8) = ${last8}`,
        ));
      if (matches.length > 0) {
        // Prefere o cliente que já tinha este JID (continuidade), senão pega o último da lista
        const preferred = matches.find(m => m.whatsappJid === lidJid) ?? matches[matches.length - 1];
        // Limpa JID de todos os outros que tinham este JID (stale)
        const staleIds = matches.filter(m => m.id !== preferred.id && m.whatsappJid === lidJid).map(m => m.id);
        if (staleIds.length > 0) {
          for (const staleId of staleIds) {
            await db.update(clientsTable).set({ whatsappJid: null }).where(eq(clientsTable.id, staleId));
          }
          logger.info(`[WA] JID ${lidJid} removido de ${staleIds.length} cliente(s) duplicado(s): ids=${staleIds.join(",")}`);
        }
        await db.update(clientsTable).set({ whatsappJid: lidJid }).where(eq(clientsTable.id, preferred.id));
        logger.info(`[WA] @lid mapeado: ${lidJid} → ${realJid} (cliente id=${preferred.id})`);
      } else {
        logger.warn(`[WA] Número ${inputPhone} (last8=${last8}) não encontrado para empresa ${companyId} — alias apenas em memória`);
      }
    }
  } catch (e: any) {
    logger.warn(`[WA] Erro ao salvar mapeamento @lid: ${e.message}`);
  }
  jidAliases.set(lidJid, realJid);
  return realJid;
}

// Pagamentos pendentes aguardando confirmação do admin (via Telegram)
// Persiste em banco para sobreviver a restarts do container
// paymentType: quando conhecido (cliente escolheu "1" ou "2" no menu), o admin-confirm
// usa essa informação diretamente em vez de tentar adivinhar por heurística de valor.
// telegramClientChatId: preenchido quando o comprovante veio do cliente falando direto
// com o bot no Telegram — usado para notificar a confirmação de volta lá, em vez de WhatsApp.
export type PendingPayment = {
  phone: string; clientName: string; clientId?: number; totalAmount?: number; instance: string; companyId?: number;
  paymentType?: "total" | "juros"; telegramClientChatId?: number; invoiceId?: number;
};
export const pendingWaPayments = new Map<string, PendingPayment>();

export async function savePendingPayment(payId: string, data: PendingPayment): Promise<void> {
  pendingWaPayments.set(payId, data);
  try {
    await db.execute(drizzleSql`
      INSERT INTO wa_pending_payments (id, phone, client_name, client_id, total_amount, instance, company_id, payment_type, telegram_client_chat_id, invoice_id)
      VALUES (${payId}, ${data.phone}, ${data.clientName}, ${data.clientId ?? null},
              ${data.totalAmount ?? null}, ${data.instance}, ${data.companyId ?? null},
              ${data.paymentType ?? null}, ${data.telegramClientChatId ?? null}, ${data.invoiceId ?? null})
      ON CONFLICT (id) DO NOTHING
    `);
  } catch (e: any) {
    logger.warn(`[WA] Erro ao persistir pagamento pendente: ${e.message}`);
  }
}

export async function loadPendingPayments(): Promise<void> {
  try {
    const rows = await db.execute(drizzleSql`SELECT * FROM wa_pending_payments`) as any;
    for (const row of rows.rows ?? rows) {
      pendingWaPayments.set(row.id, {
        phone: row.phone, clientName: row.client_name,
        clientId: row.client_id ?? undefined, totalAmount: row.total_amount ? parseFloat(row.total_amount) : undefined,
        instance: row.instance, companyId: row.company_id ?? undefined,
        paymentType: row.payment_type ?? undefined,
        telegramClientChatId: row.telegram_client_chat_id ? Number(row.telegram_client_chat_id) : undefined,
        invoiceId: row.invoice_id ?? undefined,
      });
    }
    logger.info(`[WA] ${pendingWaPayments.size} pagamento(s) pendente(s) carregado(s) do banco`);
  } catch (e: any) {
    logger.warn(`[WA] Erro ao carregar pagamentos pendentes: ${e.message}`);
  }
}

export async function removePendingPayment(payId: string): Promise<PendingPayment | undefined> {
  const data = pendingWaPayments.get(payId);
  pendingWaPayments.delete(payId);
  try {
    await db.execute(drizzleSql`DELETE FROM wa_pending_payments WHERE id = ${payId}`);
  } catch {}
  return data;
}

async function notifyAdminTelegramComprovante(payId: string, clientName: string, phone: string, imageBase64?: string): Promise<void> {
  const token   = process.env["TELEGRAM_BOT_TOKEN"];
  const adminId = process.env["TELEGRAM_ADMIN_CHAT_ID"];
  if (!token || !adminId) return;
  const caption = `📎 <b>Comprovante WhatsApp</b> de <b>${clientName}</b>\nNúmero: ${phone}\n\nDeseja confirmar o pagamento?`;
  const replyMarkup = { inline_keyboard: [[
    { text: "✅ Confirmar pagamento", callback_data: `wapy_yes:${payId}` },
    { text: "❌ Recusar",             callback_data: `wapy_no:${payId}` },
  ]] };
  const sendTextFallback = async (reason?: string) => {
    const text = reason ? `${caption}\n\n⚠️ <i>Não foi possível anexar a imagem (${reason}). Confira o comprovante direto no WhatsApp.</i>` : caption;
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: adminId, text, parse_mode: "HTML", reply_markup: replyMarkup }),
    });
    if (!res.ok) throw new Error(await res.text().catch(() => String(res.status)));
  };

  try {
    if (imageBase64) {
      try {
        const form = new FormData();
        form.append("chat_id", adminId);
        form.append("caption", caption);
        form.append("parse_mode", "HTML");
        form.append("reply_markup", JSON.stringify(replyMarkup));
        const buffer = Buffer.from(imageBase64, "base64");
        form.append("photo", new Blob([buffer], { type: "image/jpeg" }), "comprovante.jpg");
        const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: form });
        if (!res.ok) throw new Error(await res.text().catch(() => String(res.status)));
      } catch (photoErr: any) {
        // Telegram às vezes recusa a imagem (ex.: IMAGE_PROCESS_FAILED) mesmo com o pagamento
        // já persistido em wa_pending_payments — sem este fallback o admin nunca fica sabendo.
        logger.warn(`[WA] sendPhoto falhou, caindo para texto: ${photoErr.message}`);
        await sendTextFallback("erro ao processar a imagem");
      }
    } else {
      await sendTextFallback();
    }
  } catch (e: any) {
    logger.warn(`[WA] Falha ao notificar Telegram comprovante: ${e.message}`);
  }
}

// ── Formatting (WhatsApp: *bold*, _italic_, sem HTML) ─────────────────────────

function b(s: string): string  { return `*${s}*`; }
function it(s: string): string { return `_${s}_`; }
function fmtBRL(v: number): string { return `R$ ${v.toFixed(2).replace(".", ",")} `; }
function parseBRL(t: string): number {
  return parseFloat(t.replace(/\./g, "").replace(",", ".")) || 0;
}

const STATUS_LABEL: Record<string, string> = {
  overdue:   "⚠️ Vencido",
  pending:   "🕐 Pendente",
  paid:      "✅ Pago",
  current:   "🟢 Em Dia",
  requested: "📋 Solicitação",
};

const NUM_EMOJI = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];

// ── Evolution API HTTP ────────────────────────────────────────────────────────

export async function sendWA(cfg: WaConfig, phone: string, text: string): Promise<string | null> {
  // Nunca manda mensagem vazia pro WhatsApp — já aconteceu (causa não confirmada,
  // provavelmente ligada à instabilidade de conexão de 2026-07-03) e o cliente
  // recebe um balão em branco sem sentido nenhum.
  if (!text || !text.trim()) {
    logger.warn(`[WA] Envio bloqueado — texto vazio pra ${phone}`);
    return null;
  }

  // @lid: Evolution API aceita o JID completo diretamente como número de destino
  let number: string;
  if (phone.endsWith("@lid")) {
    number = phone;
  } else {
    const digits = phone.replace(/\D/g, "");
    number = digits.startsWith("55") && digits.length >= 12 ? digits : `55${digits}`;
  }
  try {
    const res = await fetch(`${cfg.apiUrl}/message/sendText/${cfg.instance}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: cfg.apiKey },
      body: JSON.stringify({ number, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(`[WA] Falha ao enviar para ${number}: ${res.status} ${body}`);
      return null;
    }
    // Retorna o remoteJid resolvido pela Evolution — pode ser @lid se o contato usa multi-device
    const data = await res.json().catch(() => null) as any;
    return data?.key?.remoteJid ?? null;
  } catch (e: any) {
    logger.warn(`[WA] Erro HTTP ao enviar para ${number}: ${e.message}`);
    return null;
  }
}

async function sendWAChunked(cfg: WaConfig, phone: string, text: string): Promise<string | null> {
  const MAX = 3800;
  if (text.length <= MAX) return sendWA(cfg, phone, text);
  const lines = text.split("\n");
  let chunk = "";
  let lastJid: string | null = null;
  for (const line of lines) {
    if (chunk.length + line.length + 1 > MAX) {
      lastJid = await sendWA(cfg, phone, chunk.trimEnd());
      chunk = line + "\n";
    } else {
      chunk += line + "\n";
    }
  }
  if (chunk.trim()) lastJid = await sendWA(cfg, phone, chunk.trimEnd());
  return lastJid;
}

// ── Normalizar telefone ───────────────────────────────────────────────────────

function normPhone(raw: string): string {
  return raw.replace(/\D/g, "");
}

function jidToPhone(jid: string): string {
  return jid.split("@")[0];
}

// Tenta casar número do cliente (pode ter ou não código do país)
function phoneMatch(registered: string | null, waPhone: string): boolean {
  if (!registered) return false;
  const reg = normPhone(registered);
  const wa  = normPhone(waPhone);
  if (reg === wa || wa.endsWith(reg) || reg.endsWith(wa)) return true;
  // Normaliza prefixo 9 do Brasil: 5519 9XXXXXXXX ↔ 5519 XXXXXXXX
  const strip9 = (n: string) => n.replace(/^(55\d{2})9(\d{8})$/, "$1$2");
  return strip9(reg) === strip9(wa);
}

// Busca cliente por telefone diretamente no SQL (sem full table scan em JS).
// Compara os últimos 8 dígitos do telefone normalizado — suficiente para casar
// formatos com/sem DDI e com/sem o 9 do celular brasileiro.
async function findClientsByPhoneSQL(companyId: number, waPhone: string) {
  const last8 = normPhone(waPhone).slice(-8);
  if (last8.length < 8) return [];
  return db.select().from(clientsTable).where(
    and(
      eq(clientsTable.companyId, companyId),
      drizzleSql`RIGHT(REGEXP_REPLACE(${clientsTable.phone}, '[^0-9]', '', 'g'), 8) = ${last8}`,
    ),
  ).limit(5);
}

// ── Lógica de negócio (igual ao Telegram, formato WhatsApp) ──────────────────

function buildInvoiceDetailWA(
  inv: typeof invoicesTable.$inferSelect,
  clientName: string,
  phone?: string,
  referral?: string,
): string {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
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
    `👤 ${b(clientName)}${phoneTag}${refTag}\n` +
    `📋 ${b(`Contrato #${inv.id}`)}\n` +
    `${statusLabel}\n\n` +
    `💰 ${b("Valor Principal:")} ${fmtBRL(principal)}\n` +
    `📅 ${b("Vencimento:")} ${dueFmt}`;

  if (rate > 0)      msg += `\n📈 ${b("Juros:")} ${inv.interestRate}%/mês`;
  if (feePerDay > 0) msg += `\n⚠️ ${b("Multa:")} ${fmtBRL(feePerDay)}/dia`;
  if (inv.recurrence) msg += `\n🔄 Recorrência: ${inv.recurrence}`;

  if (inv.status === "overdue" && daysLate > 0) {
    const periodDivisor = PERIOD_DAYS[inv.recurrence ?? "monthly"] ?? 30;
    msg += `\n\n⏳ ${b("Dias em atraso:")} ${daysLate} dias`;
    msg += `\n📆 ${b("Períodos em atraso:")} ${monthsLate} ${periodLabel(inv.recurrence, monthsLate)}`;

    if (monthsLate > 1 && (multa > 0 || jurosMes > 0)) {
      msg += `\n\n📊 ${b("Detalhamento por período:")}`;
      for (let m = 1; m <= monthsLate; m++) {
        const daysInPeriod = m < monthsLate ? periodDivisor : daysLate - periodDivisor * (monthsLate - 1);
        // Carência de 2 dias só se aplica uma vez, no início do 1º período.
        const billableDaysInPeriod = m === 1 ? billableLateDays(daysInPeriod) : daysInPeriod;
        const multaPeriod = feePerDay * billableDaysInPeriod;
        const subtotalPeriod = jurosMes + multaPeriod;
        msg += `\n\n📅 ${b(`Período ${m}:`)}`;
        if (jurosMes > 0) msg += `\n   💵 Juros: ${fmtBRL(jurosMes)}`;
        if (multaPeriod > 0) msg += `\n   💸 Multa (${billableDaysInPeriod}d): ${fmtBRL(multaPeriod)}`;
        msg += `\n   Subtotal: ${fmtBRL(subtotalPeriod)}`;
      }
      msg += "\n";
    } else {
      if (jurosMes > 0) msg += `\n\n💵 ${b("Juros acumulados:")} ${fmtBRL(jurosTotal)}`;
      if (multa > 0)    msg += `\n💸 ${b("Multa total:")} ${fmtBRL(multa)}`;
    }

    msg += `\n\n🧾 ${b("Total para quitação hoje:")} ${fmtBRL(total)}`;
  }

  msg += `\n\n📝 ${b("Observação:")}`;
  if (inv.notes) {
    msg += `\n${inv.notes}`;
    if (inv.notesUpdatedAt) {
      const d = new Date(inv.notesUpdatedAt);
      msg += `\n${it(`Atualizado em ${d.toLocaleDateString("pt-BR", { timeZone: "UTC" })} às ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })}`)}`;
    }
  } else {
    msg += `\nNenhuma observação cadastrada.`;
  }

  msg += `\n\n━━━━━━━━━━━━━━━━━━━━`;
  return msg;
}

async function buildVencidosWA(companyId?: number, referral?: string): Promise<string> {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
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
      companyName:    companiesTable.name,
    })
    .from(invoicesTable)
    .leftJoin(clientsTable,   eq(invoicesTable.clientId,  clientsTable.id))
    .leftJoin(companiesTable, eq(invoicesTable.companyId, companiesTable.id))
    .where(and(...conditions))
    .orderBy(invoicesTable.dueDate);

  if (rows.length === 0)
    return referral
      ? `✅ Nenhum cliente em atraso com indicação ${b(referral)}.`
      : `✅ ${b("Nenhum cliente em atraso no momento.")}`;

  const filterLabel = referral ? ` — indicação ${b(referral)}` : "";
  const dateStr = today.toLocaleDateString("pt-BR", { timeZone: "UTC" });
  const lines: string[] = [`📋 ${b("Clientes em Atraso")}${filterLabel} — ${dateStr}\n`];
  let totalGeral = 0;

  for (const row of rows) {
    const due = row.dueDate ? new Date(row.dueDate + "T00:00:00Z") : null;
    const daysLate   = due ? Math.max(0, Math.floor((today.getTime() - due.getTime()) / 86_400_000)) : 0;
    const principal  = parseFloat(row.amount ?? "0") || 0;
    const feePerDay  = parseFloat(row.lateFee ?? "0") || 0;
    const rate       = parseFloat(row.interestRate ?? "0") || 0;
    const multa      = feePerDay * billableLateDays(daysLate);
    const monthsLate = calcMonthsLate(row.dueDate, row.recurrence) || 1;
    const jurosMes   = (principal * rate) / 100;
    const jurosTotal = jurosMes * monthsLate;
    const total      = principal + jurosTotal + multa;
    totalGeral      += total;

    const dueDateFmt = due ? due.toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "—";
    const phone      = row.clientPhone ? ` | ${row.clientPhone}` : "";
    const companyTag = !companyId && row.companyName ? `\n   🏢 ${row.companyName}` : "";
    const refTag     = !referral && row.referralSource ? `\n   🔗 Indicação: ${row.referralSource}` : "";

    let entry =
      `👤 ${b(row.clientName ?? "—")}${phone}${companyTag}${refTag}\n` +
      `📋 Contrato #${row.invoiceId}\n` +
      `   📅 Venceu: ${dueDateFmt} | ⏳ ${b(`${daysLate} dias`)} (${monthsLate} ${periodLabel(row.recurrence, monthsLate)})\n` +
      `   💰 Principal: ${fmtBRL(principal)}`;

    if (jurosMes > 0) entry += `\n   📈 Juros (${rate}%): ${fmtBRL(jurosTotal)}`;
    if (multa > 0)    entry += `\n   ⚠️ Multa: ${billableLateDays(daysLate)}d × ${fmtBRL(feePerDay)} = ${fmtBRL(multa)}`;
    if (jurosMes > 0 || multa > 0) entry += `\n   💸 ${b(`Quitação: ${fmtBRL(total)}`)}`;
    if (row.notes)    entry += `\n   📝 ${it(row.notes)}`;

    lines.push(entry);
  }

  lines.push(`\n━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`📊 ${b(`${rows.length} cliente(s)`)} em atraso`);
  lines.push(`💸 Total geral: ${b(fmtBRL(totalGeral))}`);
  return lines.join("\n");
}

async function buildClientMessageWA(name: string, companyId?: number): Promise<string> {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const conds: any[] = [ilike(clientsTable.name, `%${name}%`)];
  if (companyId) conds.push(eq(clientsTable.companyId, companyId));

  const clients = await db.select().from(clientsTable)
    .where(and(...conds)).orderBy(clientsTable.name);

  if (clients.length === 0)
    return `❌ Nenhum cliente encontrado com o nome ${b(name)}.`;

  const lines: string[] = [];
  for (const client of clients) {
    const invoices = await db.select().from(invoicesTable)
      .where(eq(invoicesTable.clientId, client.id)).orderBy(invoicesTable.dueDate);

    const phone  = client.phone ? ` | ${client.phone}` : "";
    const refTag = client.referralSource && client.referralSource !== "invite_link"
      ? `\n🔗 Indicação: ${client.referralSource}` : "";

    const todayMs = Date.now();
    const overdueInvCount = invoices
      .filter(i => i.status === "overdue")
      .reduce((sum, i) => {
        if (!i.dueDate) return sum + 1;
        const dl = Math.max(0, Math.floor((todayMs - new Date(i.dueDate + "T00:00:00Z").getTime()) / 86_400_000));
        return sum + Math.max(1, calcMonthsLate(i.dueDate, i.recurrence));
      }, 0);
    const overdueTag = overdueInvCount > 0 ? ` | ⚠️ ${b(`${overdueInvCount} parcela${overdueInvCount > 1 ? "s" : ""} em atraso`)}` : "";
    lines.push(`👤 ${b(client.name)}${phone}${refTag}`);
    if (invoices.length > 0) lines.push(`📋 ${invoices.length} contrato${invoices.length > 1 ? "s" : ""}${overdueTag}`);

    if (invoices.length === 0) { lines.push(`   Sem cobranças registradas.\n`); continue; }

    let totalAberto = 0;
    for (const inv of invoices) {
      const due = inv.dueDate ? new Date(inv.dueDate + "T00:00:00Z") : null;
      const daysLate   = inv.status === "overdue" && due
        ? Math.max(0, Math.floor((today.getTime() - due.getTime()) / 86_400_000)) : (inv.daysLate ?? 0);
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

      let entry = `\n📋 ${b(`Contrato #${inv.id}`)} — ${statusLabel}\n   📅 Vencimento: ${dueFmt}\n   💰 Principal: ${fmtBRL(principal)}`;
      if (inv.status === "overdue") {
        if (daysLate > 0) entry += ` | ⏳ ${b(`${daysLate} dias em atraso`)}`;
        if (jurosMes > 0) {
          entry += monthsLate > 1
            ? `\n   📈 Juros: ${fmtBRL(jurosMes)}/${periodLabel(inv.recurrence, 1)} × ${monthsLate} ${periodLabel(inv.recurrence, monthsLate)} = ${b(fmtBRL(jurosTotal))}`
            : `\n   📈 Juros: ${fmtBRL(jurosTotal)}`;
        }
        if (multa > 0) entry += `\n   ⚠️ Multa: ${billableLateDays(daysLate)}d × ${fmtBRL(feePerDay)} = ${fmtBRL(multa)}`;
        if (multa > 0 || jurosMes > 0) {
          const encargos = multa + (monthsLate > 0 ? jurosTotal : 0);
          entry += `\n   Subtotal: ${fmtBRL(encargos)}`;
          entry += `\n   💸 ${b(`Quitação: ${fmtBRL(total)}`)}`;
        }
        totalAberto += total;
      }
      if (inv.notes) entry += `\n   📝 ${it(inv.notes)}`;
      lines.push(entry);
    }

    const overdueCount = invoices.filter(i => i.status === "overdue")
      .reduce((sum, i) => {
        if (!i.dueDate) return sum + 1;
        const dl = Math.max(0, Math.floor((todayMs - new Date(i.dueDate + "T00:00:00Z").getTime()) / 86_400_000));
        return sum + Math.max(1, calcMonthsLate(i.dueDate, i.recurrence));
      }, 0);
    if (overdueCount > 0) {
      lines.push(`\n   ━━━━━━━━━━━━━━━━━━━━`);
      lines.push(`   📊 ${overdueCount} parcela(s) em atraso`);
      lines.push(`   💸 Total em aberto: ${b(fmtBRL(totalAberto))}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function buildResumoWA(companyId?: number): Promise<string> {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const companyFilter = companyId ? eq(invoicesTable.companyId, companyId) : undefined;
  const clientFilter  = companyId ? eq(clientsTable.companyId, companyId)  : undefined;

  const [allClients, allInvoices] = await Promise.all([
    db.select({ id: clientsTable.id, status: clientsTable.status }).from(clientsTable).where(clientFilter),
    db.select({ status: invoicesTable.status, amount: invoicesTable.amount, lateFee: invoicesTable.lateFee,
      interestRate: invoicesTable.interestRate, dueDate: invoicesTable.dueDate, daysLate: invoicesTable.daysLate,
      recurrence: invoicesTable.recurrence })
      .from(invoicesTable).where(companyFilter),
  ]);

  let totalCarteira = 0, totalVencido = 0, totalPendente = 0, totalPago = 0, totalMultas = 0;
  let countVencido = 0, countPendente = 0;

  for (const inv of allInvoices) {
    const principal = parseFloat(inv.amount ?? "0") || 0;
    const feePerDay = parseFloat(inv.lateFee ?? "0") || 0;
    const rate      = parseFloat(inv.interestRate ?? "0") || 0;
    if (inv.status === "paid") { totalPago += principal; continue; }
    const due = inv.dueDate ? new Date(inv.dueDate + "T00:00:00Z") : null;
    const daysLate = inv.status === "overdue" && due
      ? Math.max(0, Math.floor((today.getTime() - due.getTime()) / 86_400_000)) : (inv.daysLate ?? 0);
    const multa = billableLateDays(daysLate) * feePerDay;
    const periods = inv.status === "overdue" ? calcMonthsLate(inv.dueDate, inv.recurrence) : 0;
    const juros = (principal * rate) / 100 * periods;
    const total = principal + juros + multa;
    totalCarteira += total;
    if (inv.status === "overdue") { totalVencido += total; totalMultas += multa + juros; countVencido++; }
    else { totalPendente += principal; countPendente++; }
  }

  const dateStr = today.toLocaleDateString("pt-BR", { timeZone: "UTC" });
  return [
    `📊 ${b("Resumo da Carteira")} — ${dateStr}`,
    ``,
    `👥 ${b("Clientes")}`,
    `   Total: ${b(String(allClients.length))} | Ativos: ${b(String(allClients.filter(c => c.status === "active").length))}`,
    ``,
    `💼 ${b("Carteira Ativa")}`,
    `   Total em aberto: ${b(fmtBRL(totalCarteira))}`,
    ``,
    `⚠️ ${b("Vencidos")}`,
    `   ${countVencido} cobrança(s): ${b(fmtBRL(totalVencido))}`,
    `   Juros/multas acumulados: ${b(fmtBRL(totalMultas))}`,
    ``,
    `🕐 ${b("A Receber")}`,
    `   ${countPendente} cobrança(s): ${b(fmtBRL(totalPendente))}`,
    ``,
    `✅ ${b("Já Recebido")}`,
    `   ${fmtBRL(totalPago)}`,
  ].join("\n");
}

// ── AJUDA ─────────────────────────────────────────────────────────────────────

const AJUDA_WA = `📖 ${b("Comandos disponíveis")}

${b("Visão geral:")}
/resumo — total geral da carteira

${b("Cobranças em atraso:")}
/vencidos — lista todos os contratos em atraso
/vencidos _nome_ — filtra por indicação

${b("Busca rápida:")}
/contrato 27 — detalhes completos do Contrato #27
/detalhes 27 — alias para /contrato
/cliente Lucas — ficha completa do cliente
/_nome_ — atalho: ficha do cliente (ex: /nagila)

${b("Registrar:")}
/novocliente — cadastrar novo cliente
/cobranca — registrar nova cobrança
/quitacao — registrar pagamento
/cancelar — cancelar operação em andamento

${b("Ajuda:")}
/ajuda — exibe esta mensagem

━━━━━━━━━━━━━━━━━━━━
🤖 ${it("Lastro Capital — Bot de Gestão WhatsApp")}`;

// ── Fluxo do cliente WhatsApp ─────────────────────────────────────────────────

async function buildClientMenuMsgWA(companyId: number): Promise<string> {
  const [company] = await db.select({ name: companiesTable.name })
    .from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);
  const companyName = company?.name?.toUpperCase() ?? "LASTRO CAPITAL";
  return (
    `🏦 ${b("LASTRO CAPITAL")}\n` +
    `${b(companyName)}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `👋 Olá! Bem-vindo ao atendimento digital.\n\n` +
    `Como posso te ajudar hoje?\n\n` +
    `${b("1")} — 📋 Localizar meu contrato\n` +
    `${b("2")} — 📊 Ver meu extrato\n` +
    `${b("3")} — 💳 Efetuar pagamento via PIX\n\n` +
    `${it("Responda com o número da opção.")}\n` +
    `${it("A qualquer momento, envie 0 ou \"menu\" para voltar aqui, ou \"sair\" para encerrar.")}`
  );
}

function calcClientTotalsWA(invoices: Array<typeof invoicesTable.$inferSelect>) {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  let totalAmount = 0, jurosAmount = 0;
  for (const inv of invoices) {
    if (inv.status === "paid") continue;
    const due = inv.dueDate ? new Date(inv.dueDate + "T00:00:00Z") : null;
    const daysLate = inv.status === "overdue" && due
      ? Math.max(0, Math.floor((today.getTime() - due.getTime()) / 86_400_000)) : 0;
    const monthsLate = calcMonthsLate(inv.dueDate, inv.recurrence);
    const principal  = parseFloat(inv.amount ?? "0") || 0;
    const multa      = (parseFloat(inv.lateFee ?? "0") || 0) * billableLateDays(daysLate);
    const jurosMes   = (principal * (parseFloat(inv.interestRate ?? "0") || 0)) / 100;
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

async function sendClientContratosWA(cfg: WaConfig, phone: string, clientId: number, clientName: string, companyId?: number, convKey = phone): Promise<void> {
  const invoices = await db.select().from(invoicesTable)
    .where(eq(invoicesTable.clientId, clientId)).orderBy(invoicesTable.dueDate);
  if (invoices.length === 0) {
    await sendWA(cfg, phone, `📋 ${b(clientName)}, você não possui contratos registrados.`);
    return;
  }
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  let msg = `📋 ${b(`Seus contratos — ${clientName}`)}\n\n`;
  invoices.forEach((inv, i) => {
    const due = inv.dueDate ? new Date(inv.dueDate + "T00:00:00Z") : null;
    const dueFmt = due ? due.toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "—";
    const principal = parseFloat(inv.amount ?? "0") || 0;
    const numTag = i < NUM_EMOJI.length ? NUM_EMOJI[i] : `${i + 1}.`;
    msg += `${numTag} ${STATUS_LABEL[inv.status] ?? inv.status} — ${b(dueFmt)}\n   💰 ${fmtBRL(principal)}`;
    if (inv.notes) msg += `\n   📝 ${inv.notes}`;
    msg += `\n\n`;
  });
  msg += `${it("Para detalhes financeiros, escolha a opção 2 (Extrato).")}`;
  await sendWAChunked(cfg, phone, msg);
  if (companyId) {
    waConversations.set(convKey, { step: "cl_post_contratos", isClientFlow: true, companyIdFilter: companyId, cl_clientId: clientId, cl_clientName: clientName });
  }
}

async function sendClientExtratoWA(cfg: WaConfig, phone: string, clientId: number, clientName: string, companyId?: number, convKey = phone): Promise<void> {
  const invoices = await db.select().from(invoicesTable)
    .where(and(eq(invoicesTable.clientId, clientId), ne(invoicesTable.status, "paid")))
    .orderBy(invoicesTable.dueDate);
  if (invoices.length === 0) {
    await sendWA(cfg, phone, `✅ ${b(clientName)}, você não possui cobranças em aberto!`);
    return;
  }
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const { totalAmount } = calcClientTotalsWA(invoices);
  let msg = `📊 ${b(`Extrato — ${clientName}`)}\n\n`;
  for (const inv of invoices) {
    const due = inv.dueDate ? new Date(inv.dueDate + "T00:00:00Z") : null;
    const daysLate   = inv.status === "overdue" && due
      ? Math.max(0, Math.floor((today.getTime() - due.getTime()) / 86_400_000)) : 0;
    const monthsLate = calcMonthsLate(inv.dueDate, inv.recurrence);
    const principal  = parseFloat(inv.amount ?? "0") || 0;
    const multa      = (parseFloat(inv.lateFee ?? "0") || 0) * billableLateDays(daysLate);
    const jurosMes   = (principal * (parseFloat(inv.interestRate ?? "0") || 0)) / 100;
    const jurosTotal = jurosMes * monthsLate;
    const total      = principal + multa + (monthsLate > 0 ? jurosTotal : 0);
    const dueFmt     = due ? due.toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "—";
    msg += `${STATUS_LABEL[inv.status] ?? inv.status} — venc. ${b(dueFmt)}\n`;
    msg += `💰 Principal: ${fmtBRL(principal)}`;
    if (daysLate > 0) msg += `\n📅 ${daysLate} dias em atraso (${monthsLate} ${periodLabel(inv.recurrence, monthsLate)})`;
    if (multa > 0)    msg += `\n⚠️ Multa: ${fmtBRL(multa)}`;
    if (jurosMes > 0) msg += monthsLate > 1
      ? `\n📈 Juros: ${fmtBRL(jurosMes)}/${periodLabel(inv.recurrence, 1)} × ${monthsLate} = ${fmtBRL(jurosTotal)}`
      : `\n📈 Juros: ${fmtBRL(jurosTotal)}`;
    if (inv.notes) msg += `\n📝 ${inv.notes}`;
    msg += `\n💸 Total: ${b(fmtBRL(total))}\n\n`;
  }
  msg += `━━━━━━━━━━━━━━━━━━━━\n💸 ${b(`Total em aberto: ${fmtBRL(totalAmount)}`)}\n\nDigite ${b("3")} para ver a opção de pagamento.`;
  await sendWAChunked(cfg, phone, msg);
  if (companyId) {
    waConversations.set(convKey, { step: "cl_post_extrato", isClientFlow: true, companyIdFilter: companyId, cl_clientId: clientId, cl_clientName: clientName });
  }
}

async function sendClientPaymentWA(cfg: WaConfig, phone: string, clientId: number, clientName: string, companyId: number, convKey = phone): Promise<void> {
  const [company] = await db.select({
    pixKey: companiesTable.pixKey, pixKeyType: companiesTable.pixKeyType,
    pixRecipientName: companiesTable.pixRecipientName, pixBankName: companiesTable.pixBankName,
  }).from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);

  if (!company?.pixKey) {
    await sendWA(cfg, phone, `ℹ️ A chave PIX ainda não foi configurada.\nEntre em contato diretamente para efetuar o pagamento.\n\n0️⃣ — Voltar ao menu`);
    return;
  }

  const invoices = await db.select().from(invoicesTable)
    .where(and(eq(invoicesTable.clientId, clientId), ne(invoicesTable.status, "paid")))
    .orderBy(invoicesTable.dueDate);

  if (invoices.length === 0) {
    await sendWA(cfg, phone, `✅ ${b(clientName)}, você não possui cobranças em aberto!\n\n0️⃣ — Voltar ao menu`);
    return;
  }

  // Mais de 1 contrato → deixa o cliente escolher qual pagar
  if (invoices.length > 1) {
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    let msg = `💳 ${b(`Pagamento — ${clientName}`)}\n\nVocê tem ${b(String(invoices.length))} contratos em aberto.\nEscolha qual deseja quitar:\n\n`;
    invoices.forEach((inv, i) => {
      const due = inv.dueDate ? new Date(inv.dueDate + "T00:00:00Z") : null;
      const daysLate = inv.status === "overdue" && due ? Math.max(0, Math.floor((today.getTime() - due.getTime()) / 86_400_000)) : 0;
      const principal = parseFloat(inv.amount ?? "0") || 0;
      const multa = (parseFloat(inv.lateFee ?? "0") || 0) * billableLateDays(daysLate);
      const monthsLate = calcMonthsLate(inv.dueDate, inv.recurrence);
      const juros = (principal * (parseFloat(inv.interestRate ?? "0") || 0)) / 100 * monthsLate;
      const total = principal + multa + (monthsLate > 0 ? juros : 0);
      const dueFmt = due ? due.toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "—";
      const numTag = i < NUM_EMOJI.length ? NUM_EMOJI[i] : `${i + 1}.`;
      const statusTag = STATUS_LABEL[inv.status] ?? inv.status;
      msg += `${numTag} ${b(`Contrato #${inv.id}`)} — ${statusTag}\n   📅 Venc: ${dueFmt} | 💸 ${b(fmtBRL(total))}\n\n`;
    });
    msg += `${it("Digite o número (1, 2, 3...) do contrato que deseja pagar.")}\n0️⃣ — Voltar ao menu`;
    await sendWA(cfg, phone, msg);
    waConversations.set(convKey, {
      step: "cl_select_invoice_payment", isClientFlow: true, companyIdFilter: companyId,
      cl_clientId: clientId, cl_clientName: clientName, cl_invoices: invoices,
    });
    return;
  }

  // Apenas 1 contrato → vai direto para o pagamento
  await sendPixInfoWA(cfg, phone, convKey, invoices[0], clientName, companyId, company);
}

async function sendPixInfoWA(
  cfg: WaConfig, phone: string, convKey: string,
  inv: typeof invoicesTable.$inferSelect,
  clientName: string, companyId: number,
  company: { pixKey: string | null; pixKeyType: string | null; pixRecipientName: string | null; pixBankName: string | null },
): Promise<void> {
  const { totalAmount, jurosAmount } = calcClientTotalsWA([inv]);
  const hasOverdue = inv.status === "overdue";
  const pixTypeLabel: Record<string, string> = {
    cpf: "CPF", cnpj: "CNPJ", email: "E-mail", telefone: "Telefone", aleatoria: "Chave Aleatória",
  };
  const contractRef = `Contrato #${inv.id}`;
  const dueFmt = inv.dueDate ? new Date(inv.dueDate + "T00:00:00Z").toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "";
  let msg = `💳 ${b(`Pagamento — ${clientName}`)}\n`;
  msg += `📋 ${contractRef}${dueFmt ? ` · Venc. ${dueFmt}` : ""}\n\n`;
  if (company.pixRecipientName) msg += `👤 Recebedor: ${b(company.pixRecipientName)}\n`;
  if (company.pixBankName)      msg += `🏦 Banco: ${company.pixBankName}\n`;
  msg += `🔑 Chave PIX (${pixTypeLabel[company.pixKeyType ?? ""] ?? "PIX"}): ${b(company.pixKey ?? "")}\n`;
  msg += `💸 Valor: ${b(fmtBRL(totalAmount))}`;

  // Oferece a escolha "quitação total vs. somente juros" sempre que houver juros a
  // cobrar, vencida ou não — fatura recorrente em dia também tem o juros do ciclo
  // como opção válida (é o modelo do empréstimo). Antes só oferecia quando já vencida,
  // então uma fatura em dia ia direto pro "pague o total" sem alternativa, e se o
  // cliente pagasse só o juros mesmo assim, o sistema não tinha como saber.
  if (jurosAmount > 0) {
    const jurosLabel = hasOverdue ? "Juros + multas acumulados" : "Somente juros do mês";
    msg += `\n\n📈 ${jurosLabel}: ${b(fmtBRL(jurosAmount))}`;
    msg += `\n\nComo deseja efetuar o pagamento?\n${b("1")} — Quitar total (${fmtBRL(totalAmount)})\n${b("2")} — Pagar ${hasOverdue ? "somente juros + multas" : "somente o juros do mês"} (${fmtBRL(jurosAmount)})\n0️⃣ — Voltar ao menu\n\n${it("Responda com 1, 2 ou 0.")}`;
    waConversations.set(convKey, {
      step: "cl_payment_type", isClientFlow: true, companyIdFilter: companyId,
      cl_clientId: inv.clientId, cl_clientName: clientName,
      cl_totalAmount: totalAmount, cl_jurosAmount: jurosAmount, cl_invoiceId: inv.id,
    });
  } else {
    msg += `\n\nApós realizar o pagamento, envie o comprovante aqui. 📎\n\n0️⃣ — Voltar ao menu`;
    waConversations.set(convKey, {
      step: "cl_await_comprovante", isClientFlow: true, companyIdFilter: companyId,
      cl_clientId: inv.clientId, cl_clientName: clientName, cl_totalAmount: totalAmount, cl_invoiceId: inv.id,
    });
  }
  await sendWA(cfg, phone, msg);
}

// ── Handler do fluxo cliente ──────────────────────────────────────────────────

async function handleClientStepWA(
  cfg: WaConfig, phone: string, convKey: string, text: string,
  state: WaConvState, companyId: number,
): Promise<void> {
  const input = text.trim();
  const inputLower = input.toLowerCase();

  // Sair do bot: encerra o atendimento sem reabrir o menu — útil quando o assunto
  // muda pra algo fora do fluxo (ex: cliente já pagou e a conversa segue livre).
  if (inputLower === "sair" || inputLower === "encerrar" || inputLower === "tchau") {
    waConversations.delete(convKey);
    await sendWA(cfg, phone, `👋 Ok, encerrei o atendimento por aqui.\n\n${it("Quando precisar, é só digitar")} ${b("menu")}.`);
    return;
  }

  // Voltar ao menu: "0", "menu", "/start", "cancelar" em qualquer etapa do fluxo cliente
  if (input === "0" || inputLower === "menu" || inputLower === "/start" || inputLower === "cancelar" || inputLower === "/cancelar") {
    waConversations.delete(convKey);
    if (!state.companyIdFilter) {
      await sendWA(cfg, phone, `Menu reiniciado.\n\nDigite ${b("menu")} para começar.`);
      return;
    }
    const menuMsg = await buildClientMenuMsgWA(state.companyIdFilter);
    await sendWA(cfg, phone, menuMsg);
    waConversations.set(convKey, { step: "cl_menu", isClientFlow: true, companyIdFilter: state.companyIdFilter });
    return;
  }

  switch (state.step) {
    case "cl_menu": {
      if (input !== "1" && input !== "2" && input !== "3") {
        await sendWA(cfg, phone, `❌ Opção inválida. Digite ${b("1")}, ${b("2")} ou ${b("3")}:`);
        return;
      }
      waConversations.delete(convKey);
      const [[linkedByJid], linkedByPhoneRows] = await Promise.all([
        db.select().from(clientsTable)
          .where(and(eq(clientsTable.companyId, companyId), eq(clientsTable.whatsappJid, convKey))).limit(1),
        findClientsByPhoneSQL(companyId, phone),
      ]);
      // Telefone tem prioridade: se a busca por phone retornou um cliente diferente do JID salvo,
      // significa que o admin reatribuiu o número — transferir o @lid para o cliente correto.
      const phoneClient = linkedByPhoneRows[0];
      const jidClient   = linkedByJid;
      if (phoneClient && jidClient && phoneClient.id !== jidClient.id) {
        // Remove @lid do cliente antigo e atribui ao novo
        await db.update(clientsTable).set({ whatsappJid: null }).where(eq(clientsTable.id, jidClient.id));
        await db.update(clientsTable).set({ whatsappJid: convKey }).where(eq(clientsTable.id, phoneClient.id));
        jidAliases.set(convKey, normalizePhoneForWA(phoneClient.phone ?? phone));
        logger.info(`[WA] @lid ${convKey} transferido de cliente #${jidClient.id} para #${phoneClient.id}`);
      } else if (phoneClient && !phoneClient.whatsappJid) {
        // Novo cliente identificado por telefone — salvar JID
        await db.update(clientsTable).set({ whatsappJid: convKey }).where(eq(clientsTable.id, phoneClient.id));
      }
      const client = phoneClient ?? jidClient;
      const action: WaConvState["cl_action"] = input === "1" ? "contratos" : input === "2" ? "extrato" : "pagar";
      if (client) {
        if (action === "contratos") await sendClientContratosWA(cfg, phone, client.id, client.name, companyId, convKey);
        else if (action === "extrato") await sendClientExtratoWA(cfg, phone, client.id, client.name, companyId, convKey);
        else await sendClientPaymentWA(cfg, phone, client.id, client.name, companyId, convKey);
      } else {
        waConversations.set(convKey, { step: "cl_identify", isClientFlow: true, companyIdFilter: companyId, cl_action: action });
        await sendWA(cfg, phone, `🔍 Informe seu ${b("nome")}, ${b("CPF")} ou ${b("telefone")} cadastrado:`);
      }
      break;
    }

    case "cl_identify": {
      const digits = input.replace(/\D/g, "");
      const byDoc  = digits.length >= 11
        ? await db.select().from(clientsTable)
            .where(and(eq(clientsTable.companyId, companyId), eq(clientsTable.document, digits))).limit(5)
        : [];
      const byName = byDoc.length === 0
        ? await db.select().from(clientsTable)
            .where(and(eq(clientsTable.companyId, companyId), ilike(clientsTable.name, `%${input}%`))).limit(10)
        : [];
      // Busca por telefone: aceita formatos com ou sem DDD/DDI
      const byPhone = byDoc.length === 0 && byName.length === 0 && digits.length >= 8
        ? await findClientsByPhoneSQL(companyId, digits)
        : [];
      const candidates = byDoc.length > 0 ? byDoc : byName.length > 0 ? byName : byPhone;

      if (candidates.length === 0) {
        await sendWA(cfg, phone, `❌ Não encontrei nenhum cliente com essas informações.\n\nTente seu nome, CPF ou telefone cadastrado.`);
        waConversations.delete(convKey);
        return;
      }
      if (candidates.length > 1) {
        let msg = `🔍 Encontrei ${b(`${candidates.length} clientes`)}. Informe seu CPF para confirmar:\n\n`;
        candidates.forEach(c => msg += `• ${c.name}\n`);
        waConversations.set(convKey, { step: "cl_identify_multi", isClientFlow: true, companyIdFilter: companyId, cl_action: state.cl_action, cl_matchedClients: candidates.map(c => ({ id: c.id, name: c.name, document: c.document })) });
        await sendWA(cfg, phone, msg);
        return;
      }
      const client = candidates[0];
      waConversations.delete(convKey);
      // Salva JID para auto-identificação futura (qualquer formato, não só @lid)
      if (!client.whatsappJid) {
        await db.update(clientsTable).set({ whatsappJid: convKey }).where(eq(clientsTable.id, client.id));
      }
      if (convKey.endsWith("@lid") && client.phone) {
        await saveJidMapping(convKey, client.phone, companyId);
      }
      const action = state.cl_action ?? "contratos";
      if (action === "contratos") await sendClientContratosWA(cfg, phone, client.id, client.name, companyId, convKey);
      else if (action === "extrato") await sendClientExtratoWA(cfg, phone, client.id, client.name, companyId, convKey);
      else await sendClientPaymentWA(cfg, phone, client.id, client.name, companyId, convKey);
      break;
    }

    case "cl_identify_multi": {
      const digits = input.replace(/\D/g, "");
      const clients = state.cl_matchedClients ?? [];
      const found = clients.find(c => c.document && normPhone(c.document) === digits);
      if (!found) {
        await sendWA(cfg, phone, `❌ CPF não reconhecido. Tente novamente:`);
        return;
      }
      waConversations.delete(convKey);
      // Salva JID para auto-identificação futura
      const [clData] = await db.select({ phone: clientsTable.phone, whatsappJid: clientsTable.whatsappJid })
        .from(clientsTable).where(eq(clientsTable.id, found.id)).limit(1);
      if (!clData?.whatsappJid) {
        await db.update(clientsTable).set({ whatsappJid: convKey }).where(eq(clientsTable.id, found.id));
      }
      if (convKey.endsWith("@lid") && clData?.phone) {
        await saveJidMapping(convKey, clData.phone, companyId);
      }
      const action = state.cl_action ?? "contratos";
      if (action === "contratos") await sendClientContratosWA(cfg, phone, found.id, found.name, companyId, convKey);
      else if (action === "extrato") await sendClientExtratoWA(cfg, phone, found.id, found.name, companyId, convKey);
      else await sendClientPaymentWA(cfg, phone, found.id, found.name, companyId, convKey);
      break;
    }

    case "cl_select_invoice_payment": {
      const invs = state.cl_invoices ?? [];
      const idx = parseInt(input) - 1;
      if (isNaN(idx) || idx < 0 || idx >= invs.length) {
        await sendWA(cfg, phone, `❌ Número inválido. Digite entre 1 e ${invs.length} ou 0 para voltar ao menu.`);
        return;
      }
      const [company] = await db.select({
        pixKey: companiesTable.pixKey, pixKeyType: companiesTable.pixKeyType,
        pixRecipientName: companiesTable.pixRecipientName, pixBankName: companiesTable.pixBankName,
      }).from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);
      if (!company?.pixKey) {
        await sendWA(cfg, phone, `ℹ️ Chave PIX não configurada. Entre em contato.\n\n0️⃣ — Voltar ao menu`);
        return;
      }
      await sendPixInfoWA(cfg, phone, convKey, invs[idx], state.cl_clientName!, companyId, company);
      break;
    }

    case "cl_post_contratos": {
      if (input === "2") {
        waConversations.delete(convKey);
        await sendClientExtratoWA(cfg, phone, state.cl_clientId!, state.cl_clientName!, companyId, convKey);
      } else if (input === "3") {
        waConversations.delete(convKey);
        await sendClientPaymentWA(cfg, phone, state.cl_clientId!, state.cl_clientName!, companyId, convKey);
      } else {
        await sendWA(cfg, phone, `${b("2")} — Extrato\n${b("3")} — Pagamento\n0️⃣ — Menu principal`);
      }
      break;
    }

    case "cl_post_extrato": {
      if (input === "3") {
        waConversations.delete(convKey);
        await sendClientPaymentWA(cfg, phone, state.cl_clientId!, state.cl_clientName!, companyId, convKey);
      } else {
        await sendWA(cfg, phone, `${b("3")} — Pagamento via PIX\n0️⃣ — Menu principal`);
      }
      break;
    }

    case "cl_payment_type": {
      if (input !== "1" && input !== "2") {
        await sendWA(cfg, phone, `❌ Responda com ${b("1")}, ${b("2")} ou ${b("0")} para voltar.`);
        return;
      }
      waConversations.delete(convKey);
      const total = input === "1" ? (state.cl_totalAmount ?? 0) : (state.cl_jurosAmount ?? 0);
      const label = input === "1" ? "Quitação Total" : "Juros + Taxas de Atraso";

      const [company] = await db.select({
        pixKey: companiesTable.pixKey, pixKeyType: companiesTable.pixKeyType,
        pixRecipientName: companiesTable.pixRecipientName, pixBankName: companiesTable.pixBankName,
      }).from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);

      const pixTypeLabel: Record<string, string> = {
        cpf: "CPF", cnpj: "CNPJ", email: "E-mail", telefone: "Telefone", aleatoria: "Chave Aleatória",
      };

      let msg = `💳 ${b(`${label} — ${state.cl_clientName ?? ""}`)}\n\n`;
      msg += `💸 Valor: ${b(fmtBRL(total))}\n`;
      if (company?.pixRecipientName) msg += `👤 Recebedor: ${b(company.pixRecipientName)}\n`;
      if (company?.pixBankName)      msg += `🏦 Banco: ${company.pixBankName}\n`;
      if (company?.pixKey)           msg += `🔑 Chave PIX (${pixTypeLabel[company.pixKeyType ?? ""] ?? "PIX"}): ${company.pixKey}\n`;
      msg += `\nApós realizar o pagamento, envie o comprovante aqui. 📎`;

      await sendWA(cfg, phone, msg);
      waConversations.set(convKey, {
        step: "cl_await_comprovante", isClientFlow: true, companyIdFilter: companyId,
        cl_clientId: state.cl_clientId, cl_clientName: state.cl_clientName, cl_totalAmount: total,
        cl_paymentType: input === "1" ? "total" : "juros", cl_invoiceId: state.cl_invoiceId,
      });
      break;
    }

    case "cl_await_comprovante":
      await sendWA(cfg, phone, `⏳ Aguardando seu comprovante. Envie uma foto ou arquivo.`);
      break;

    default:
      waConversations.delete(convKey);
  }
}

// ── Handler conversa admin ────────────────────────────────────────────────────

async function handleConvStepWA(cfg: WaConfig, phone: string, text: string, state: WaConvState): Promise<void> {
  const input = text.trim();
  if (input === "/cancelar" || input.toLowerCase() === "cancelar") {
    waConversations.delete(phone);
    await sendWA(cfg, phone, `Operação cancelada.`);
    return;
  }

  switch (state.step) {
    // ── /novocliente ──
    case "nc_name": {
      state.nc_name = input;
      state.step = "nc_phone";
      waConversations.set(phone, state);
      await sendWA(cfg, phone, `📱 Telefone do cliente (ou "pular"):`);
      break;
    }
    case "nc_phone": {
      state.nc_phone = input === "pular" ? undefined : input;
      state.step = "nc_document";
      waConversations.set(phone, state);
      await sendWA(cfg, phone, `🪪 CPF/CNPJ (ou "pular"):`);
      break;
    }
    case "nc_document": {
      state.nc_document = input === "pular" ? undefined : input.replace(/\D/g, "");
      state.step = "nc_referral";
      waConversations.set(phone, state);
      await sendWA(cfg, phone, `🔗 Indicação/origem do cliente (ou "pular"):`);
      break;
    }
    case "nc_referral": {
      const refVal = input === "pular" ? null : input;
      waConversations.delete(phone);
      const cId = state.companyIdFilter;
      if (!cId) { await sendWA(cfg, phone, `❌ Empresa não identificada.`); break; }
      const [client] = await db.insert(clientsTable).values({
        companyId: cId, name: state.nc_name!, phone: state.nc_phone ?? null,
        document: state.nc_document ?? null, referralSource: refVal, status: "active",
      }).returning();
      await sendWA(cfg, phone, `✅ ${b("Cliente cadastrado!")}\n\n👤 ${b(client.name)}\n🔢 ID: #${client.id}`);
      break;
    }

    // ── /cobranca ──
    case "client": {
      const cId = state.companyIdFilter!;
      const found = await db.select().from(clientsTable)
        .where(and(eq(clientsTable.companyId, cId), ilike(clientsTable.name, `%${input}%`))).limit(10);
      if (found.length === 0) { await sendWA(cfg, phone, `❌ Nenhum cliente encontrado. Tente novamente:`); return; }
      if (found.length === 1) {
        state.clientId = found[0].id; state.clientName = found[0].name; state.step = "amount";
        waConversations.set(phone, state);
        await sendWA(cfg, phone, `👤 ${b(found[0].name)}\n\n💰 Valor da cobrança (ex: 1.500,00):`);
      } else {
        const list = found.map((c, i) => `${i + 1}. ${c.name}`).join("\n");
        state.step = "select_client"; state.pendingClients = found.map(c => ({ id: c.id, name: c.name, companyId: c.companyId, companyName: null }));
        waConversations.set(phone, state);
        await sendWA(cfg, phone, `Encontrei ${found.length} clientes:\n\n${list}\n\nDigite o número:`);
      }
      break;
    }
    case "select_client": {
      const idx = parseInt(input) - 1;
      const list = state.pendingClients ?? [];
      if (isNaN(idx) || idx < 0 || idx >= list.length) { await sendWA(cfg, phone, `❌ Número inválido. Digite entre 1 e ${list.length}:`); return; }
      state.clientId = list[idx].id; state.clientName = list[idx].name; state.step = "amount";
      waConversations.set(phone, state);
      await sendWA(cfg, phone, `👤 ${b(list[idx].name)}\n\n💰 Valor da cobrança:`);
      break;
    }
    case "amount": {
      const v = parseBRL(input);
      if (v <= 0) { await sendWA(cfg, phone, `❌ Valor inválido. Ex: 1.500,00`); return; }
      state.amount = v; state.step = "due_date";
      waConversations.set(phone, state);
      await sendWA(cfg, phone, `📅 Data de vencimento (DD/MM/AAAA):`);
      break;
    }
    case "due_date": {
      const [d, m, y] = input.split("/");
      const dateStr = `${y}-${m?.padStart(2, "0")}-${d?.padStart(2, "0")}`;
      if (!Date.parse(dateStr)) { await sendWA(cfg, phone, `❌ Data inválida. Use DD/MM/AAAA:`); return; }
      state.dueDate = dateStr; state.step = "interest";
      waConversations.set(phone, state);
      await sendWA(cfg, phone, `📈 Taxa de juros % ao mês (0 para sem juros):`);
      break;
    }
    case "interest": {
      state.interestRate = parseFloat(input.replace(",", ".")) || 0;
      state.step = "late_fee";
      waConversations.set(phone, state);
      await sendWA(cfg, phone, `⚠️ Multa por dia de atraso em R$ (0 para sem multa):`);
      break;
    }
    case "late_fee": {
      state.lateFee = parseBRL(input) || 0;
      waConversations.delete(phone);
      const cId = state.companyIdFilter!;
      const today = new Date().toISOString().split("T")[0];
      const newStatus = (state.dueDate ?? "") > today ? "pending" : "overdue";
      const [invoice] = await db.insert(invoicesTable).values({
        companyId: cId, clientId: state.clientId!, amount: String(state.amount!.toFixed(2)),
        dueDate: state.dueDate ?? null, status: newStatus,
        interestRate: String((state.interestRate ?? 0).toFixed(2)),
        lateFee: String((state.lateFee ?? 0).toFixed(2)), daysLate: 0,
      }).returning();
      if (newStatus === "overdue") {
        await db.insert(debtsTable).values({ companyId: cId, clientId: state.clientId!, invoiceId: invoice.id, status: "open", daysOverdue: 0 });
      }
      await sendWA(cfg, phone,
        `✅ ${b("Cobrança registrada!")}\n\n` +
        `👤 ${b(state.clientName ?? "")}\n` +
        `💰 ${fmtBRL(state.amount!)}\n` +
        `📅 Vencimento: ${state.dueDate}\n` +
        `🔢 ID: #${invoice.id}`
      );
      break;
    }

    // ── /quitacao ──
    case "qt_client": {
      const cId = state.companyIdFilter!;
      const found = await db.select({ id: clientsTable.id, name: clientsTable.name, companyId: clientsTable.companyId })
        .from(clientsTable)
        .where(and(eq(clientsTable.companyId, cId), ilike(clientsTable.name, `%${input}%`))).limit(10);
      if (found.length === 0) { await sendWA(cfg, phone, `❌ Nenhum cliente encontrado. Tente novamente:`); return; }
      const invs = await db.select({ id: invoicesTable.id, amount: invoicesTable.amount, dueDate: invoicesTable.dueDate,
        status: invoicesTable.status, interestRate: invoicesTable.interestRate, lateFee: invoicesTable.lateFee,
        daysLate: invoicesTable.daysLate, recurrence: invoicesTable.recurrence, interestPaid: invoicesTable.interestPaid })
        .from(invoicesTable).where(and(eq(invoicesTable.clientId, found[0].id), ne(invoicesTable.status, "paid")));
      if (found.length === 1 && invs.length === 1) {
        state.qt_clientId = found[0].id; state.qt_clientName = found[0].name; state.qt_clientCompanyId = found[0].companyId;
        state.qt_invoices = invs; state.qt_invoiceIdx = 0; state.step = "qt_type";
        waConversations.set(phone, state);
        const inv = invs[0];
        await sendWA(cfg, phone, `👤 ${b(found[0].name)}\n\nRegistrar:\n${b("1")} — Quitação total\n${b("2")} — Somente juros/multa`);
      } else if (found.length === 1) {
        const today = new Date(); today.setUTCHours(0, 0, 0, 0);
        state.qt_clientId = found[0].id; state.qt_clientName = found[0].name; state.qt_clientCompanyId = found[0].companyId;
        state.qt_invoices = invs; state.step = "qt_select_invoice";
        waConversations.set(phone, state);
        const list = invs.map((i, idx) => {
          const due = i.dueDate ? new Date(i.dueDate + "T00:00:00Z") : null;
          const dl = i.status === "overdue" && due ? Math.max(0, Math.floor((today.getTime() - due.getTime()) / 86_400_000)) : 0;
          return `${idx + 1}. ${STATUS_LABEL[i.status] ?? i.status} — ${due ? due.toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "—"} | ${fmtBRL(parseFloat(i.amount ?? "0") || 0)}${dl > 0 ? ` | ${dl}d` : ""}`;
        }).join("\n");
        await sendWA(cfg, phone, `👤 ${b(found[0].name)}\n\nEscolha a cobrança:\n\n${list}\n\nDigite o número:`);
      } else {
        const listMsg = found.map((c, i) => `${i + 1}. ${c.name}`).join("\n");
        state.qt_pendingClients = found; state.step = "qt_select_client";
        waConversations.set(phone, state);
        await sendWA(cfg, phone, `Encontrei ${found.length} clientes:\n\n${listMsg}\n\nDigite o número:`);
      }
      break;
    }
    case "qt_select_client": {
      const idx = parseInt(input) - 1;
      const list = state.qt_pendingClients ?? [];
      if (isNaN(idx) || idx < 0 || idx >= list.length) { await sendWA(cfg, phone, `❌ Número inválido:`); return; }
      const c = list[idx];
      const invs = await db.select({ id: invoicesTable.id, amount: invoicesTable.amount, dueDate: invoicesTable.dueDate,
        status: invoicesTable.status, interestRate: invoicesTable.interestRate, lateFee: invoicesTable.lateFee,
        daysLate: invoicesTable.daysLate, recurrence: invoicesTable.recurrence, interestPaid: invoicesTable.interestPaid })
        .from(invoicesTable).where(and(eq(invoicesTable.clientId, c.id), ne(invoicesTable.status, "paid")));
      state.qt_clientId = c.id; state.qt_clientName = c.name; state.qt_clientCompanyId = c.companyId;
      state.qt_invoices = invs;
      if (invs.length === 1) {
        state.qt_invoiceIdx = 0; state.step = "qt_type";
        waConversations.set(phone, state);
        await sendWA(cfg, phone, `👤 ${b(c.name)}\n\nRegistrar:\n${b("1")} — Quitação total\n${b("2")} — Somente juros/multa`);
      } else {
        const today = new Date(); today.setUTCHours(0, 0, 0, 0);
        state.step = "qt_select_invoice";
        waConversations.set(phone, state);
        const l = invs.map((i, idx2) => {
          const due = i.dueDate ? new Date(i.dueDate + "T00:00:00Z") : null;
          const dl = i.status === "overdue" && due ? Math.max(0, Math.floor((today.getTime() - due.getTime()) / 86_400_000)) : 0;
          return `${idx2 + 1}. ${STATUS_LABEL[i.status] ?? i.status} — ${due ? due.toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "—"} | ${fmtBRL(parseFloat(i.amount ?? "0") || 0)}${dl > 0 ? ` | ${dl}d` : ""}`;
        }).join("\n");
        await sendWA(cfg, phone, `👤 ${b(c.name)}\n\nEscolha a cobrança:\n\n${l}\n\nDigite o número:`);
      }
      break;
    }
    case "qt_select_invoice": {
      const idx = parseInt(input) - 1;
      const invs = state.qt_invoices ?? [];
      if (isNaN(idx) || idx < 0 || idx >= invs.length) { await sendWA(cfg, phone, `❌ Número inválido:`); return; }
      state.qt_invoiceIdx = idx; state.step = "qt_type";
      waConversations.set(phone, state);
      await sendWA(cfg, phone, `Registrar:\n${b("1")} — Quitação total\n${b("2")} — Somente juros/multa`);
      break;
    }
    case "qt_type": {
      if (input !== "1" && input !== "2") { await sendWA(cfg, phone, `❌ Digite 1 ou 2.`); return; }
      waConversations.delete(phone);
      const invs = state.qt_invoices ?? [];
      const inv  = invs[state.qt_invoiceIdx ?? 0];
      if (!inv) { await sendWA(cfg, phone, `❌ Cobrança não encontrada.`); break; }
      const cId  = state.qt_clientCompanyId ?? state.companyIdFilter!;
      const isPaid = input === "1";
      const principal = parseFloat(inv.amount ?? "0") || 0;
      if (isPaid) {
        // Quitação total: marca como pago e fecha a dívida
        await db.update(invoicesTable).set({ status: "paid", interestPaid: true }).where(eq(invoicesTable.id, inv.id));
        await db.update(debtsTable).set({ status: "closed" }).where(and(eq(debtsTable.invoiceId, inv.id), eq(debtsTable.status, "open")));
        if (principal > 0) {
          await db.insert(cashFlowTable).values({ companyId: cId, type: "income", amount: String(principal.toFixed(2)), description: `Quitação via bot WhatsApp — ${state.qt_clientName} (#${inv.id})`, category: "cobranças", date: new Date() });
        }
        await sendWA(cfg, phone, `✅ ${b("Quitação registrada!")}\n\n👤 ${b(state.qt_clientName ?? "")}\n💰 ${fmtBRL(principal)}\n🔢 #${inv.id}`);
        // Notificar o cliente via WhatsApp (número diferente do admin)
        try {
          if (state.qt_clientId) {
            const [clientRow] = await db.select({ phone: clientsTable.phone })
              .from(clientsTable).where(eq(clientsTable.id, state.qt_clientId)).limit(1);
            const clientPhone = clientRow?.phone;
            const adminNorm = normalizePhoneForWA(phone);
            if (clientPhone && clientPhone !== adminNorm && clientPhone !== phone) {
              const dueFmt = inv.dueDate ? new Date(inv.dueDate + "T00:00:00Z").toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "";
              await sendWA(cfg, clientPhone,
                `✅ *Pagamento confirmado!*\n\nOlá, *${state.qt_clientName ?? ""}*!\n\nSeu pagamento foi registrado com sucesso.\n\n📋 Contrato: *#${inv.id}*${dueFmt ? `\n📅 Vencimento: ${dueFmt}` : ""}\n💸 Valor: *${fmtBRL(principal)}*\n\nObrigado! 🙏`);
            }
          }
        } catch {}
      } else {
        // Juros/multa pagos → avança recorrência se for contrato recorrente
        const today = new Date(); today.setUTCHours(0, 0, 0, 0);
        const due = inv.dueDate ? new Date(inv.dueDate + "T00:00:00Z") : null;
        const daysLate = inv.status === "overdue" && due ? Math.max(0, Math.floor((today.getTime() - due.getTime()) / 86_400_000)) : 0;
        const monthsLate = calcMonthsLate(inv.dueDate, inv.recurrence);
        const multa = (parseFloat(inv.lateFee ?? "0") || 0) * billableLateDays(daysLate);
        const jurosMes = principal * (parseFloat(inv.interestRate ?? "0") || 0) / 100;
        const jurosTotal = jurosMes * monthsLate;
        const extra = multa + (monthsLate > 0 ? jurosTotal : 0);

        // Fecha dívida aberta
        await db.update(debtsTable).set({ status: "closed" }).where(and(eq(debtsTable.invoiceId, inv.id), eq(debtsTable.status, "open")));

        // Avança recorrência se houver; senão apenas marca interestPaid
        let newDueDateFmt = "";
        let newStatusMsg = it("Fatura permanece em aberto — principal não quitado.");
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
                companyId: cId, clientId: state.qt_clientId!, invoiceId: inv.id, status: "open", daysOverdue: 0,
              });
            }
          }
          newDueDateFmt = new Date(newDueDate + "T00:00:00Z").toLocaleDateString("pt-BR", { timeZone: "UTC" });
          newStatusMsg = newStatus === "current"
            ? `✅ Status: *Em Dia*\n📅 Próx. vencimento: *${newDueDateFmt}*`
            : `⚠️ Status: *Vencido*\n📅 Nova data: *${newDueDateFmt}*`;
        } else {
          // Sem recorrência: apenas marca juros pagos e muda de vencido → em dia
          const noRecStatus = inv.status === "overdue" ? "current" : inv.status;
          await db.update(invoicesTable)
            .set({ interestPaid: true, status: noRecStatus })
            .where(eq(invoicesTable.id, inv.id));
          newStatusMsg = `✅ Status: *Em Dia*`;
        }

        if (extra > 0) {
          await db.insert(cashFlowTable).values({ companyId: cId, type: "income", amount: String(extra.toFixed(2)), description: `Juros/multa via bot WhatsApp — ${state.qt_clientName} (#${inv.id})`, category: "juros", date: new Date() });
        }
        await sendWA(cfg, phone, `✅ ${b("Juros/multa registrados!")}\n\n👤 ${b(state.qt_clientName ?? "")}\n📈 Juros+Multa: ${fmtBRL(extra)}\n🔢 #${inv.id}\n\n${newStatusMsg}`);
      }
      break;
    }

    // ── cs_select_invoice ──
    case "cs_select_invoice": {
      const invs = state.cs_invoices ?? [];
      const idx  = parseInt(input) - 1;
      if (isNaN(idx) || idx < 0 || idx >= invs.length) {
        await sendWA(cfg, phone, `❌ Número inválido. Digite entre 1 e ${invs.length} ou /cancelar:`);
        return;
      }
      waConversations.delete(phone);
      const msg = buildInvoiceDetailWA(invs[idx], state.cs_clientName ?? "—", state.cs_clientPhone, state.cs_clientRef);
      await sendWAChunked(cfg, phone, msg);
      break;
    }

    default:
      waConversations.delete(phone);
  }
}

// ── Dispatcher de comandos admin via WhatsApp ─────────────────────────────────

async function handleAdminCommandWA(
  cfg: WaConfig, phone: string, convKey: string, text: string,
): Promise<void> {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(" ").trim();
  const cId = cfg.companyId;

  switch (cmd) {
    case "/ajuda":
    case "/help":
      await sendWA(cfg, phone, AJUDA_WA);
      break;

    case "/resumo":
      await sendWAChunked(cfg, phone, await buildResumoWA(cId));
      break;

    case "/vencidos":
      await sendWAChunked(cfg, phone, await buildVencidosWA(cId, arg || undefined));
      break;

    case "/cliente":
      if (!arg) { await sendWA(cfg, phone, `❌ Use: /cliente Nome`); break; }
      await sendWAChunked(cfg, phone, await buildClientMessageWA(arg, cId));
      break;

    case "/contrato":
    case "/detalhes": {
      const id = parseInt(arg);
      if (!id) { await sendWA(cfg, phone, `❌ Use: /contrato 27`); break; }
      const conds: any[] = [eq(invoicesTable.id, id)];
      if (cId) conds.push(eq(invoicesTable.companyId, cId));
      const [inv] = await db.select().from(invoicesTable).where(and(...conds)).limit(1);
      if (!inv) { await sendWA(cfg, phone, `❌ Contrato #${id} não encontrado.`); break; }
      const [cl] = await db.select().from(clientsTable).where(eq(clientsTable.id, inv.clientId)).limit(1);
      await sendWAChunked(cfg, phone, buildInvoiceDetailWA(inv, cl?.name ?? "—", cl?.phone ?? undefined, cl?.referralSource ?? undefined));
      break;
    }

    case "/novocliente":
      if (!cId) { await sendWA(cfg, phone, `❌ companyId não configurado.`); break; }
      waConversations.set(convKey, { step: "nc_name", companyIdFilter: cId, isClientFlow: false });
      await sendWA(cfg, phone, `👤 ${b("Novo cliente")}\n\nDigite o ${b("nome completo")} do cliente:`);
      break;

    case "/cobranca":
      if (!cId) { await sendWA(cfg, phone, `❌ companyId não configurado.`); break; }
      waConversations.set(convKey, { step: "client", companyIdFilter: cId, isClientFlow: false });
      await sendWA(cfg, phone, `📋 ${b("Nova cobrança")}\n\nDigite o nome do ${b("cliente")}:`);
      break;

    case "/quitacao":
      if (!cId) { await sendWA(cfg, phone, `❌ companyId não configurado.`); break; }
      waConversations.set(convKey, { step: "qt_client", companyIdFilter: cId, isClientFlow: false });
      await sendWA(cfg, phone, `✅ ${b("Registrar quitação")}\n\nDigite o nome do ${b("cliente")}:`);
      break;

    case "/cancelar":
      waConversations.delete(convKey);
      await sendWA(cfg, phone, `Operação cancelada.`);
      break;

    default:
      // Atalho /nome → busca cliente
      if (cmd.startsWith("/") && cmd.length > 1) {
        const name = cmd.slice(1);
        await sendWAChunked(cfg, phone, await buildClientMessageWA(name, cId));
      } else {
        await sendWA(cfg, phone, AJUDA_WA);
      }
  }
}

// ── Webhook principal ─────────────────────────────────────────────────────────

export async function handleWhatsAppWebhook(cfg: WaConfig, payload: any): Promise<void> {
  try {
    const event = payload?.event as string | undefined;
    if (event !== "messages.upsert") return;

    const data = payload?.data;
    if (!data) return;

    const jid = data.key?.remoteJid as string | undefined;
    if (!jid || jid.endsWith("@g.us")) return;

    // Ignora mensagens enviadas pelo próprio bot
    if (data.key?.fromMe === true) return;

    // Para @lid: usa o JID completo como identificador (Evolution aceita @lid no sendText).
    // Para real phone: extrai apenas os dígitos.
    const senderPhone = jid.endsWith("@lid") ? jid : jidToPhone(jid);

    // Dedup: Evolution API entrega o mesmo evento duas vezes (@lid + real phone).
    // Estratégia:
    //   1. @lid sem alias → adia 3s esperando o JID real (não marca como processado)
    //   2. JID real chega → registra alias @lid→real e processa normalmente
    //   3. @lid COM alias → processa normalmente via alias
    //   4. Duplicata de msgId já processado → apenas registra alias e descarta
    const msgId = data.key?.id as string | undefined;
    if (msgId) {
      if (processedMsgIds.has(msgId)) {
        // Segunda entrega: registra alias @lid↔real para futuras mensagens
        const firstJid = msgIdToJid.get(msgId);
        if (firstJid && firstJid !== senderPhone) {
          if (firstJid.endsWith("@lid") && !senderPhone.endsWith("@lid")) {
            // @lid processado primeiro, real phone chega depois → registra alias
            if (cfg.companyId) {
              saveJidMapping(firstJid, senderPhone, cfg.companyId).catch(() => {});
            } else {
              jidAliases.set(firstJid, senderPhone.includes("@") ? senderPhone : `${senderPhone}@s.whatsapp.net`);
            }
          } else if (senderPhone.endsWith("@lid") && !firstJid.endsWith("@lid")) {
            // real phone primeiro, @lid depois → registra alias
            jidAliases.set(senderPhone, firstJid.includes("@") ? firstJid : `${firstJid}@s.whatsapp.net`);
          }
        }
        return;
      }

      // @lid sem mapeamento e sem fallback ativo → adia para esperar o JID real
      if (senderPhone.endsWith("@lid") && !jidAliases.has(senderPhone) && !lidFallbacks.has(msgId)) {
        msgIdToJid.set(msgId, senderPhone);
        setTimeout(async () => {
          if (!processedMsgIds.has(msgId)) {
            // JID real nunca chegou → processa com @lid como fallback
            lidFallbacks.add(msgId);
            msgIdToJid.delete(msgId);
            await handleWhatsAppWebhook(cfg, payload).catch(e =>
              logger.warn({ err: e }, "[WA] Erro no fallback @lid"),
            );
            setTimeout(() => lidFallbacks.delete(msgId), 5_000);
          }
        }, 3_000);
        return;
      }

      // JID real chegando: verifica se havia @lid pendente (sem processedMsgIds) para o mesmo msgId
      if (!senderPhone.endsWith("@lid")) {
        const priorLid = msgIdToJid.get(msgId);
        if (priorLid?.endsWith("@lid")) {
          // Registra alias @lid → real phone (memória + banco)
          if (cfg.companyId) {
            saveJidMapping(priorLid, senderPhone, cfg.companyId).catch(() => {});
          } else {
            jidAliases.set(priorLid, senderPhone.includes("@") ? senderPhone : `${senderPhone}@s.whatsapp.net`);
          }
          logger.info({ priorLid, realPhone: senderPhone }, "[WA] alias @lid→real registrado na chegada do JID real");
        }
      }

      processedMsgIds.add(msgId);
      msgIdToJid.set(msgId, senderPhone);
      setTimeout(() => { processedMsgIds.delete(msgId); msgIdToJid.delete(msgId); }, 60_000);
    }

    const text: string =
      data.message?.conversation ??
      data.message?.extendedTextMessage?.text ??
      "";
    const hasMedia = !!(data.message?.imageMessage || data.message?.documentMessage || data.message?.audioMessage);

    logger.info({ senderPhone, event, hasMedia, hasText: !!text, convStep: waConversations.get(senderPhone)?.step ?? "none" }, "[WA] webhook recebido");

    // Carrega mapeamentos @lid do banco (lazy, uma vez por processo)
    await ensureJidMappings();

    // Resolve telefone real para envio: se @lid tiver mapeamento, usa o JID real
    const aliasPhone = jidAliases.get(senderPhone);
    const sendPhone = aliasPhone ?? senderPhone; // JID real para respostas

    // Comprovante de pagamento enviado pelo cliente
    if (hasMedia) {
      const mediaBare = aliasPhone?.split("@")[0];
      const mediaConv = waConversations.get(senderPhone)
        ?? (aliasPhone ? waConversations.get(aliasPhone) : undefined)
        ?? (mediaBare  ? waConversations.get(mediaBare)  : undefined);
      const mediaKey = waConversations.has(senderPhone) ? senderPhone
        : (aliasPhone && waConversations.has(aliasPhone)) ? aliasPhone
        : (mediaBare && waConversations.has(mediaBare)) ? mediaBare : senderPhone;
      const activeConv = mediaConv;
      if (activeConv?.step === "cl_await_comprovante") {
        const clName = activeConv.cl_clientName ?? "cliente";
        waConversations.delete(mediaKey);
        await sendWA(cfg, sendPhone, `✅ Comprovante recebido!\n\nSeu pagamento está sendo processado. Em breve você receberá a confirmação. 🙏`);
        const payId = `wapay_${Date.now()}`;
        await savePendingPayment(payId, { phone: sendPhone, clientName: clName, clientId: activeConv.cl_clientId, totalAmount: activeConv.cl_totalAmount, instance: cfg.instance, companyId: cfg.companyId, paymentType: activeConv.cl_paymentType, invoiceId: activeConv.cl_invoiceId });
        const imageBase64 = data.message?.base64 as string | undefined;
        await notifyAdminTelegramComprovante(payId, clName, sendPhone, imageBase64);
      } else {
        logger.warn({ senderPhone, convStep: activeConv?.step ?? "none" }, "[WA] imagem ignorada — sem estado cl_await_comprovante");
      }
      return;
    }

    if (!text) return;

    // Conversa em andamento: busca sob senderPhone, depois alias (com/sem @s.whatsapp.net)
    // Necessário porque o menu pode ter sido processado pelo JID real e a próxima mensagem chega como @lid
    const aliasBare = aliasPhone?.split("@")[0]; // dígitos sem sufixo @s.whatsapp.net
    const activeConv = waConversations.get(senderPhone)
      ?? (aliasPhone ? waConversations.get(aliasPhone) : undefined)
      ?? (aliasBare  ? waConversations.get(aliasBare)  : undefined);
    // Migra conversa para senderPhone atual para que operações seguintes usem chave consistente
    if (activeConv && !waConversations.has(senderPhone)) {
      const oldKey = (aliasPhone && waConversations.has(aliasPhone)) ? aliasPhone
        : (aliasBare && waConversations.has(aliasBare)) ? aliasBare : null;
      if (oldKey) { waConversations.delete(oldKey); waConversations.set(senderPhone, activeConv); }
    }
    const convPhone = sendPhone; // JID real para enviar respostas
    const convKey = senderPhone;  // chave original do mapa (pode ser @lid)

    // Detecta admin pelo telefone configurado
    const adminDigits = cfg.adminPhone ? normPhone(cfg.adminPhone) : null;
    // isAdmin: compara APENAS o senderPhone real (sem alias).
    // Motivo: o alias de um cliente pode coincidir com o adminPhone se ambos usam o mesmo número.
    // Admin commands chegam via JID real do telefone admin, não via @lid de clientes.
    const senderDigits = normPhone(senderPhone.replace("@s.whatsapp.net", "").replace("@lid", ""));
    const isAdmin = !!adminDigits && (
      senderDigits.endsWith(adminDigits) || adminDigits.endsWith(senderDigits)
    );

    if (activeConv) {
      if (activeConv.isClientFlow) {
        await handleClientStepWA(cfg, convPhone, convKey, text, activeConv, cfg.companyId ?? activeConv.companyIdFilter ?? 0);
      } else {
        // Fluxo admin (/novocliente, /cobranca, /quitacao etc.)
        await handleConvStepWA(cfg, convPhone, text, activeConv);
      }
      return;
    }

    // ── Admin commands ──
    if (isAdmin) {
      await handleAdminCommandWA(cfg, convPhone, convKey, text);
      return;
    }

    // Clientes: ativa com /start ou "menu"
    const rawCmd = text.trim().split(/\s+/)[0].toLowerCase();
    if (rawCmd !== "/start" && rawCmd !== "menu") return;

    if (!cfg.companyId) return;

    // Se @lid incluir número no texto ("menu 5519999...") → tenta registrar alias imediatamente
    if (senderPhone.endsWith("@lid") && !aliasPhone && cfg.companyId) {
      const phoneInText = text.trim().match(/\b\d{7,15}\b/);
      if (phoneInText) {
        await saveJidMapping(senderPhone, phoneInText[0], cfg.companyId).catch(() => {});
      }
      // Sem número no texto: Evolution aceita @lid como destino — menu é enviado assim mesmo.
      // Se o cliente tiver telefone salvo no banco, será identificado em cl_menu via whatsappJid.
      // Se não, passará por cl_identify (uma única vez) e o @lid ficará salvo para as próximas.
    }

    const menuMsg = await buildClientMenuMsgWA(cfg.companyId);
    await sendWA(cfg, sendPhone, menuMsg);
    waConversations.set(senderPhone, { step: "cl_menu", isClientFlow: true, companyIdFilter: cfg.companyId });

  } catch (e: any) {
    logger.error({ err: e }, "[WA] Erro ao processar webhook");
  }
}

// ── Inicialização da instância ────────────────────────────────────────────────

export async function initWhatsAppInstance(cfg: WaConfig, webhookUrl: string): Promise<void> {
  try {
    // Verifica se a instância já existe
    const listRes = await fetch(`${cfg.apiUrl}/instance/fetchInstances`, {
      headers: { apikey: cfg.apiKey },
    });
    if (!listRes.ok) {
      logger.warn(`[WA] Não foi possível conectar à Evolution API: ${listRes.status}`);
      return;
    }
    const instances = (await listRes.json()) as any[];
    const exists = Array.isArray(instances) && instances.some((i: any) => (i.name ?? i.instance?.instanceName) === cfg.instance);

    if (!exists) {
      logger.info(`[WA] Criando instância "${cfg.instance}"...`);
      await fetch(`${cfg.apiUrl}/instance/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: cfg.apiKey },
        body: JSON.stringify({
          instanceName: cfg.instance,
          token: cfg.apiKey,
          qrcode: true,
          integration: "WHATSAPP-BAILEYS",
          webhook: { url: webhookUrl, enabled: true, events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE"] },
        }),
      });
      logger.info(`[WA] Instância criada. Acesse http://SEU_SERVIDOR:8181 para escanear o QR code.`);
    } else {
      logger.info(`[WA] Instância "${cfg.instance}" já existe.`);
    }
  } catch (e: any) {
    logger.warn(`[WA] Erro ao inicializar instância: ${e.message}`);
  }
}

// Consulta direta o estado real da sessão na Evolution API — usado como fallback
// quando o whatsapp_status do banco diz "disconnected" mas pode estar apenas
// dessincronizado (ex: evento connection.update "open" da reconexão não chegou).
export async function checkInstanceConnected(cfg: Pick<WaConfig, "apiUrl" | "apiKey" | "instance">): Promise<boolean> {
  try {
    const res = await fetch(`${cfg.apiUrl}/instance/connectionState/${cfg.instance}`, {
      headers: { apikey: cfg.apiKey },
    });
    if (!res.ok) return false;
    const data = (await res.json()) as any;
    const state = data?.instance?.state ?? data?.state;
    return state === "open";
  } catch {
    return false;
  }
}

// whatsapp_status no banco só é atualizado pelo webhook connection.update.
// Se esse evento se perder numa reconexão rápida, o flag fica preso em
// "disconnected" pra sempre e trava os avisos automáticos (cobrança de
// atraso e lembrete de vencimento) mesmo com o WhatsApp funcionando de
// verdade (bug real: MARA BANK, 2026-07-08 — caiu 04:20 BRT, reconectou
// sozinho, cron das 08:00 pulou clientes porque o banco nunca soube da
// reconexão). Antes de desistir de um company "disconnected", confirma
// direto na Evolution API e, se estiver aberta, já corrige o flag
// (auto-cura) em vez de só usar pra essa rodada.
export async function empresaWhatsAppConectado(
  company: Pick<typeof companiesTable.$inferSelect, "id" | "name" | "whatsappInstance" | "whatsappStatus">,
): Promise<boolean> {
  if (!company.whatsappInstance) return false;
  if (company.whatsappStatus === "connected") return true;

  const cfg = {
    apiUrl: process.env.EVOLUTION_SERVER_URL ?? "http://evolution:8080",
    apiKey: process.env.EVOLUTION_API_KEY ?? "",
    instance: company.whatsappInstance,
  };
  const realmenteAberto = await checkInstanceConnected(cfg);
  if (!realmenteAberto) return false;

  logger.warn(`[WA] Empresa "${company.name}" estava "disconnected" no banco mas Evolution reporta "open" — corrigindo flag (auto-cura)`);
  await db.update(companiesTable).set({ whatsappStatus: "connected" }).where(eq(companiesTable.id, company.id));
  return true;
}

export async function getWhatsAppQR(cfg: WaConfig): Promise<{ qrcode?: string; state?: string; pairingCode?: string }> {
  try {
    const res = await fetch(`${cfg.apiUrl}/instance/connect/${cfg.instance}`, {
      headers: { apikey: cfg.apiKey },
    });
    if (!res.ok) return { state: "error" };
    return await res.json() as { qrcode?: string; state?: string; pairingCode?: string };
  } catch {
    return { state: "error" };
  }
}
