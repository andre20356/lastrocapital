import { db, invoicesTable, clientsTable, companiesTable, debtsTable, cashFlowTable } from "@workspace/db";
import { eq, and, ilike, ne, or } from "drizzle-orm";
import { logger } from "../lib/logger";

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
  | "cl_menu" | "cl_identify" | "cl_identify_multi" | "cl_payment_type" | "cl_await_comprovante";

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
  cl_totalAmount?: number; cl_jurosAmount?: number;
  cl_matchedClients?: Array<{ id: number; name: string; document: string | null }>;
}

const waConversations = new Map<string, WaConvState>();

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

export async function sendWA(cfg: WaConfig, phone: string, text: string): Promise<void> {
  try {
    const res = await fetch(`${cfg.apiUrl}/message/sendText/${cfg.instance}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: cfg.apiKey },
      body: JSON.stringify({ number: phone, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(`[WA] Falha ao enviar para ${phone}: ${res.status} ${body}`);
    }
  } catch (e: any) {
    logger.warn(`[WA] Erro HTTP: ${e.message}`);
  }
}

async function sendWAChunked(cfg: WaConfig, phone: string, text: string): Promise<void> {
  const MAX = 3800;
  if (text.length <= MAX) { await sendWA(cfg, phone, text); return; }
  const lines = text.split("\n");
  let chunk = "";
  for (const line of lines) {
    if (chunk.length + line.length + 1 > MAX) {
      await sendWA(cfg, phone, chunk.trimEnd());
      chunk = line + "\n";
    } else {
      chunk += line + "\n";
    }
  }
  if (chunk.trim()) await sendWA(cfg, phone, chunk.trimEnd());
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
  return reg === wa || wa.endsWith(reg) || reg.endsWith(wa);
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
  const monthsLate = (inv.status === "overdue" && daysLate > 0)
    ? Math.max(1, Math.floor(daysLate / 30)) : 0;
  const multa      = feePerDay * daysLate;
  const jurosMes   = (principal * rate) / 100;
  const jurosTotal = jurosMes * (monthsLate || 1);
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
    msg += `\n\n⏳ ${b("Dias em atraso:")} ${daysLate} dias`;
    msg += `\n📆 ${b("Meses em atraso:")} ${monthsLate} mês${monthsLate > 1 ? "es" : ""}`;

    if (monthsLate > 1 && (multa > 0 || jurosMes > 0)) {
      msg += `\n\n📊 ${b("Detalhamento por mês:")}`;
      for (let m = 1; m <= monthsLate; m++) {
        const daysInMonth = m < monthsLate ? 30 : daysLate - 30 * (monthsLate - 1);
        const multaMes = feePerDay * daysInMonth;
        const subtotalMes = jurosMes + multaMes;
        msg += `\n\n📅 ${b(`Mês ${m}:`)}`;
        if (jurosMes > 0) msg += `\n   💵 Juros: ${fmtBRL(jurosMes)}`;
        if (multaMes > 0) msg += `\n   💸 Multa (${daysInMonth}d): ${fmtBRL(multaMes)}`;
        msg += `\n   Subtotal: ${fmtBRL(subtotalMes)}`;
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
    const multa      = feePerDay * daysLate;
    const monthsLate = Math.max(1, Math.floor(daysLate / 30));
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
      `   📅 Venceu: ${dueDateFmt} | ⏳ ${b(`${daysLate} dias`)} (${monthsLate} mês${monthsLate > 1 ? "es" : ""})\n` +
      `   💰 Principal: ${fmtBRL(principal)}`;

    if (jurosMes > 0) entry += `\n   📈 Juros (${rate}%): ${fmtBRL(jurosTotal)}`;
    if (multa > 0)    entry += `\n   ⚠️ Multa: ${daysLate}d × ${fmtBRL(feePerDay)} = ${fmtBRL(multa)}`;
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
        return sum + Math.max(1, Math.floor(dl / 30));
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
      const monthsLate = (inv.status === "overdue" && daysLate > 0)
        ? Math.max(1, Math.floor(daysLate / 30)) : 0;
      const multa      = feePerDay * daysLate;
      const jurosMes   = (principal * rate) / 100;
      const jurosTotal = jurosMes * (monthsLate || 1);
      const total      = principal + multa + (monthsLate > 0 ? jurosTotal : 0);
      const dueFmt     = due ? due.toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "—";
      const statusLabel = STATUS_LABEL[inv.status] ?? inv.status;

      let entry = `\n📋 ${b(`Contrato #${inv.id}`)} — ${statusLabel}\n   📅 Vencimento: ${dueFmt}\n   💰 Principal: ${fmtBRL(principal)}`;
      if (inv.status === "overdue") {
        if (daysLate > 0) entry += ` | ⏳ ${b(`${daysLate} dias em atraso`)}`;
        if (jurosMes > 0) {
          entry += monthsLate > 1
            ? `\n   📈 Juros: ${fmtBRL(jurosMes)}/mês × ${monthsLate} meses = ${b(fmtBRL(jurosTotal))}`
            : `\n   📈 Juros: ${fmtBRL(jurosTotal)}`;
        }
        if (multa > 0) entry += `\n   ⚠️ Multa: ${daysLate}d × ${fmtBRL(feePerDay)} = ${fmtBRL(multa)}`;
        if (multa > 0 || jurosMes > 0) entry += `\n   💸 ${b(`Quitação: ${fmtBRL(total)}`)}`;
        totalAberto += total;
      }
      if (inv.notes) entry += `\n   📝 ${it(inv.notes)}`;
      lines.push(entry);
    }

    const overdueCount = invoices.filter(i => i.status === "overdue")
      .reduce((sum, i) => {
        if (!i.dueDate) return sum + 1;
        const dl = Math.max(0, Math.floor((todayMs - new Date(i.dueDate + "T00:00:00Z").getTime()) / 86_400_000));
        return sum + Math.max(1, Math.floor(dl / 30));
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
      interestRate: invoicesTable.interestRate, dueDate: invoicesTable.dueDate, daysLate: invoicesTable.daysLate })
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
    const multa = feePerDay * daysLate;
    const juros = (principal * rate) / 100;
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
    `${it("Responda com o número da opção.")}`
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
    const monthsLate = daysLate > 0 ? Math.max(1, Math.floor(daysLate / 30)) : 0;
    const principal  = parseFloat(inv.amount ?? "0") || 0;
    const multa      = (parseFloat(inv.lateFee ?? "0") || 0) * daysLate;
    const jurosMes   = (principal * (parseFloat(inv.interestRate ?? "0") || 0)) / 100;
    const jurosTotal = jurosMes * (monthsLate || 1);
    const extra = multa + (monthsLate > 0 ? jurosTotal : 0);
    totalAmount += principal + extra;
    jurosAmount += extra;
  }
  return { totalAmount, jurosAmount };
}

async function sendClientContratosWA(cfg: WaConfig, phone: string, clientId: number, clientName: string): Promise<void> {
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
    msg += `${numTag} ${STATUS_LABEL[inv.status] ?? inv.status} — ${b(dueFmt)}\n   💰 ${fmtBRL(principal)}\n\n`;
  });
  msg += `${it("Para detalhes financeiros, escolha a opção 2 (Extrato).")}`;
  await sendWAChunked(cfg, phone, msg);
}

async function sendClientExtratoWA(cfg: WaConfig, phone: string, clientId: number, clientName: string): Promise<void> {
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
    const monthsLate = daysLate > 0 ? Math.max(1, Math.floor(daysLate / 30)) : 0;
    const principal  = parseFloat(inv.amount ?? "0") || 0;
    const multa      = (parseFloat(inv.lateFee ?? "0") || 0) * daysLate;
    const jurosMes   = (principal * (parseFloat(inv.interestRate ?? "0") || 0)) / 100;
    const jurosTotal = jurosMes * (monthsLate || 1);
    const total      = principal + multa + (monthsLate > 0 ? jurosTotal : 0);
    const dueFmt     = due ? due.toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "—";
    msg += `${STATUS_LABEL[inv.status] ?? inv.status} — venc. ${b(dueFmt)}\n`;
    msg += `💰 Principal: ${fmtBRL(principal)}`;
    if (daysLate > 0) msg += `\n📅 ${daysLate} dias em atraso (${monthsLate} mês${monthsLate > 1 ? "es" : ""})`;
    if (multa > 0)    msg += `\n⚠️ Multa: ${fmtBRL(multa)}`;
    if (jurosMes > 0) msg += monthsLate > 1
      ? `\n📈 Juros: ${fmtBRL(jurosMes)}/mês × ${monthsLate} = ${fmtBRL(jurosTotal)}`
      : `\n📈 Juros: ${fmtBRL(jurosTotal)}`;
    msg += `\n💸 Total: ${b(fmtBRL(total))}\n\n`;
  }
  msg += `━━━━━━━━━━━━━━━━━━━━\n💸 ${b(`Total em aberto: ${fmtBRL(totalAmount)}`)}\n\nDigite ${b("3")} para ver a opção de pagamento.`;
  await sendWAChunked(cfg, phone, msg);
}

async function sendClientPaymentWA(cfg: WaConfig, phone: string, clientId: number, clientName: string, companyId: number): Promise<void> {
  const [company] = await db.select({
    pixKey: companiesTable.pixKey, pixKeyType: companiesTable.pixKeyType,
    pixRecipientName: companiesTable.pixRecipientName, pixBankName: companiesTable.pixBankName,
  }).from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);

  if (!company?.pixKey) {
    await sendWA(cfg, phone, `ℹ️ A chave PIX ainda não foi configurada.\nEntre em contato diretamente para efetuar o pagamento.`);
    return;
  }

  const invoices = await db.select().from(invoicesTable)
    .where(and(eq(invoicesTable.clientId, clientId), ne(invoicesTable.status, "paid")));
  if (invoices.length === 0) {
    await sendWA(cfg, phone, `✅ ${b(clientName)}, você não possui cobranças em aberto!`);
    return;
  }

  const { totalAmount, jurosAmount } = calcClientTotalsWA(invoices);
  const hasOverdue = invoices.some(i => i.status === "overdue");

  const pixTypeLabel: Record<string, string> = {
    cpf: "CPF", cnpj: "CNPJ", email: "E-mail", telefone: "Telefone", aleatoria: "Chave Aleatória",
  };
  let msg = `💳 ${b(`Pagamento — ${clientName}`)}\n\n`;
  msg += `💸 Valor total em aberto: ${b(fmtBRL(totalAmount))}\n`;
  if (company.pixRecipientName) msg += `👤 Recebedor: ${b(company.pixRecipientName)}\n`;
  if (company.pixBankName)      msg += `🏦 Banco: ${company.pixBankName}\n`;
  msg += `🔑 Chave PIX (${pixTypeLabel[company.pixKeyType ?? ""] ?? "PIX"}): ${company.pixKey}\n`;
  msg += `💸 Valor: ${b(fmtBRL(totalAmount))}`;

  if (hasOverdue && jurosAmount > 0) {
    msg += `\n\n📈 Somente juros + multas: ${b(fmtBRL(jurosAmount))}`;
    msg += `\n\nComo deseja efetuar o pagamento?\n${b("1")} — Quitar valor total (${fmtBRL(totalAmount)})\n${b("2")} — Pagar somente juros + taxas (${fmtBRL(jurosAmount)})\n\n${it("Responda com 1 ou 2.")}`;
    waConversations.set(phone, {
      step: "cl_payment_type", isClientFlow: true, companyIdFilter: companyId,
      cl_clientId: clientId, cl_clientName: clientName,
      cl_totalAmount: totalAmount, cl_jurosAmount: jurosAmount,
    });
  } else {
    msg += `\n\nApós realizar o pagamento, envie o comprovante aqui. 📎`;
    waConversations.set(phone, {
      step: "cl_await_comprovante", isClientFlow: true, companyIdFilter: companyId,
      cl_clientId: clientId, cl_clientName: clientName,
    });
  }
  await sendWA(cfg, phone, msg);
}

// ── Handler do fluxo cliente ──────────────────────────────────────────────────

async function handleClientStepWA(
  cfg: WaConfig, phone: string, text: string,
  state: WaConvState, companyId: number,
): Promise<void> {
  const input = text.trim();

  if (input === "/cancelar" || input.toLowerCase() === "cancelar") {
    waConversations.delete(phone);
    await sendWA(cfg, phone, `Operação cancelada.\n\nDigite ${b("menu")} para voltar ao início.`);
    return;
  }

  switch (state.step) {
    case "cl_menu": {
      if (input !== "1" && input !== "2" && input !== "3") {
        await sendWA(cfg, phone, `❌ Opção inválida. Digite ${b("1")}, ${b("2")} ou ${b("3")}:`);
        return;
      }
      waConversations.delete(phone);
      const [linked] = await db.select().from(clientsTable)
        .where(and(eq(clientsTable.companyId, companyId), eq(clientsTable.telegramChatId, phone))).limit(1);
      // Tenta também por número de telefone
      const linkedByPhone = !linked
        ? (await db.select().from(clientsTable).where(eq(clientsTable.companyId, companyId))).find(c => phoneMatch(c.phone, phone))
        : null;
      const client = linked ?? linkedByPhone;
      const action: WaConvState["cl_action"] = input === "1" ? "contratos" : input === "2" ? "extrato" : "pagar";
      if (client) {
        if (action === "contratos") await sendClientContratosWA(cfg, phone, client.id, client.name);
        else if (action === "extrato") await sendClientExtratoWA(cfg, phone, client.id, client.name);
        else await sendClientPaymentWA(cfg, phone, client.id, client.name, companyId);
      } else {
        waConversations.set(phone, { step: "cl_identify", isClientFlow: true, companyIdFilter: companyId, cl_action: action });
        await sendWA(cfg, phone, `🔍 Informe seu ${b("CPF")} ou ${b("nome completo")} cadastrado:`);
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
      const candidates = byDoc.length > 0 ? byDoc : byName;

      if (candidates.length === 0) {
        await sendWA(cfg, phone, `❌ Não encontrei nenhum cliente com essas informações.\n\nTente CPF ou nome completo.`);
        waConversations.delete(phone);
        return;
      }
      if (candidates.length > 1) {
        let msg = `🔍 Encontrei ${b(`${candidates.length} clientes`)}. Informe seu CPF para confirmar:\n\n`;
        candidates.forEach(c => msg += `• ${c.name}\n`);
        waConversations.set(phone, { step: "cl_identify_multi", isClientFlow: true, companyIdFilter: companyId, cl_action: state.cl_action, cl_matchedClients: candidates.map(c => ({ id: c.id, name: c.name, document: c.document })) });
        await sendWA(cfg, phone, msg);
        return;
      }
      const client = candidates[0];
      waConversations.delete(phone);
      const action = state.cl_action ?? "contratos";
      if (action === "contratos") await sendClientContratosWA(cfg, phone, client.id, client.name);
      else if (action === "extrato") await sendClientExtratoWA(cfg, phone, client.id, client.name);
      else await sendClientPaymentWA(cfg, phone, client.id, client.name, companyId);
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
      waConversations.delete(phone);
      const action = state.cl_action ?? "contratos";
      if (action === "contratos") await sendClientContratosWA(cfg, phone, found.id, found.name);
      else if (action === "extrato") await sendClientExtratoWA(cfg, phone, found.id, found.name);
      else await sendClientPaymentWA(cfg, phone, found.id, found.name, companyId);
      break;
    }

    case "cl_payment_type": {
      if (input !== "1" && input !== "2") {
        await sendWA(cfg, phone, `❌ Responda com ${b("1")} ou ${b("2")}.`);
        return;
      }
      waConversations.delete(phone);
      const total = input === "1" ? (state.cl_totalAmount ?? 0) : (state.cl_jurosAmount ?? 0);
      await sendWA(cfg, phone, `💸 Valor a pagar: ${b(fmtBRL(total))}\n\nApós realizar o PIX, envie o comprovante aqui. 📎`);
      waConversations.set(phone, { step: "cl_await_comprovante", isClientFlow: true, companyIdFilter: companyId, cl_clientId: state.cl_clientId, cl_clientName: state.cl_clientName });
      break;
    }

    case "cl_await_comprovante":
      await sendWA(cfg, phone, `⏳ Aguardando seu comprovante. Envie uma foto ou arquivo.`);
      break;

    default:
      waConversations.delete(phone);
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
      await db.update(invoicesTable).set({ status: "paid", interestPaid: true }).where(eq(invoicesTable.id, inv.id));
      await db.update(debtsTable).set({ status: "closed" }).where(and(eq(debtsTable.invoiceId, inv.id), eq(debtsTable.status, "open")));
      const principal = parseFloat(inv.amount ?? "0") || 0;
      if (isPaid && principal > 0) {
        await db.insert(cashFlowTable).values({ companyId: cId, type: "income", amount: String(principal.toFixed(2)), description: `Quitação via bot WhatsApp — ${state.qt_clientName} (#${inv.id})`, category: "cobranças", date: new Date() });
      }
      await sendWA(cfg, phone, `✅ ${b("Pagamento registrado!")}\n\n👤 ${b(state.qt_clientName ?? "")}\n💰 ${fmtBRL(principal)}\n🔢 #${inv.id}`);
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

// ── Webhook principal ─────────────────────────────────────────────────────────

export async function handleWhatsAppWebhook(cfg: WaConfig, payload: any): Promise<void> {
  try {
    const event = payload?.event as string | undefined;

    // Apenas mensagens recebidas
    if (event !== "messages.upsert") return;

    const data = payload?.data;
    if (!data) return;

    // Ignora mensagens enviadas por nós mesmos
    if (data.key?.fromMe === true) return;

    const jid  = data.key?.remoteJid as string | undefined;
    if (!jid || jid.endsWith("@g.us")) return; // ignora grupos

    const senderPhone = jidToPhone(jid);

    // Extrai texto da mensagem
    const text: string =
      data.message?.conversation ??
      data.message?.extendedTextMessage?.text ??
      "";

    const hasMedia = !!(data.message?.imageMessage || data.message?.documentMessage || data.message?.audioMessage);

    const isClientMode = !!cfg.companyId && !!cfg.companyChatId && senderPhone !== normPhone(cfg.adminPhone);

    // ── Comprovante de cliente ──────────────────────────────────────────────
    if (hasMedia && isClientMode) {
      const activeConv = waConversations.get(senderPhone);
      if (activeConv?.step === "cl_await_comprovante") {
        const clName = activeConv.cl_clientName ?? "cliente";
        waConversations.delete(senderPhone);
        await sendWA(cfg, senderPhone, `✅ Comprovante recebido!\n\nSeu pagamento está sendo processado. Em breve você receberá a confirmação. 🙏`);
        if (cfg.companyChatId) {
          await sendWA(cfg, cfg.companyChatId, `📎 ${b("Comprovante recebido")} de ${b(clName)}!\nNúmero: ${senderPhone}`);
        }
        return;
      }
      if (isClientMode) return; // ignora outras mídias de cliente
    }

    if (!text) return;

    // ── Conversa em andamento ───────────────────────────────────────────────
    const activeConv = waConversations.get(senderPhone);
    if (activeConv) {
      if (isClientMode || activeConv.isClientFlow) {
        await handleClientStepWA(cfg, senderPhone, text, activeConv, cfg.companyId ?? activeConv.companyIdFilter ?? 0);
      } else {
        await handleConvStepWA(cfg, senderPhone, text, activeConv);
      }
      return;
    }

    const rawCmd = text.trim().split(/\s+/)[0].toLowerCase();
    const isVencidos = rawCmd === "/vencidos" || rawCmd === "/vencido" ||
      rawCmd.startsWith("/vencidos") || rawCmd.startsWith("/vencido");

    // ── MODO CLIENTE ────────────────────────────────────────────────────────
    if (isClientMode) {
      if (rawCmd === "/start" || rawCmd === "/ajuda" || rawCmd === "/help" || text.trim().toLowerCase() === "menu") {
        const menuMsg = await buildClientMenuMsgWA(cfg.companyId!);
        await sendWA(cfg, senderPhone, menuMsg);
        waConversations.set(senderPhone, { step: "cl_menu", isClientFlow: true, companyIdFilter: cfg.companyId });
      } else if (text.trim() === "1" || text.trim() === "2" || text.trim() === "3") {
        const fakeState: WaConvState = { step: "cl_menu", isClientFlow: true, companyIdFilter: cfg.companyId };
        waConversations.set(senderPhone, fakeState);
        await handleClientStepWA(cfg, senderPhone, text, fakeState, cfg.companyId!);
      } else {
        // Mensagem livre → repassa ao admin
        const [linked] = await db.select({ name: clientsTable.name, phone: clientsTable.phone })
          .from(clientsTable)
          .where(and(eq(clientsTable.companyId, cfg.companyId!), eq(clientsTable.telegramChatId, senderPhone))).limit(1);
        const senderName = linked?.name ?? `WhatsApp ${senderPhone}`;
        if (cfg.companyChatId) {
          await sendWA(cfg, cfg.companyChatId, `💬 ${b(senderName)} | ${senderPhone}:\n${text}`);
        }
        await sendWA(cfg, senderPhone, `✅ Mensagem recebida! Nossa equipe entrará em contato em breve.`);
      }
      return;
    }

    // ── MODO ADMIN ──────────────────────────────────────────────────────────
    if (rawCmd === "/ajuda" || rawCmd === "/help" || rawCmd === "/start") {
      await sendWA(cfg, senderPhone, AJUDA_WA);

    } else if (rawCmd === "/resumo") {
      const msg = await buildResumoWA(cfg.companyId);
      await sendWA(cfg, senderPhone, msg);

    } else if (rawCmd === "/contrato" || rawCmd === "/detalhes") {
      const idStr = text.trim().slice(rawCmd.length).trim().replace(/^#/, "");
      const id = parseInt(idStr, 10);
      if (isNaN(id) || id <= 0) {
        await sendWA(cfg, senderPhone, `❌ Informe o número do contrato.\nEx: /contrato 27`);
      } else {
        const conds: any[] = [eq(invoicesTable.id, id)];
        if (cfg.companyId) conds.push(eq(invoicesTable.companyId, cfg.companyId));
        const [row] = await db
          .select({ invoice: invoicesTable, clientName: clientsTable.name, clientPhone: clientsTable.phone, clientRef: clientsTable.referralSource })
          .from(invoicesTable).leftJoin(clientsTable, eq(invoicesTable.clientId, clientsTable.id))
          .where(and(...conds));
        if (!row) {
          await sendWA(cfg, senderPhone, `❌ Contrato #${id} não encontrado.`);
        } else {
          const msg = buildInvoiceDetailWA(row.invoice, row.clientName ?? "—", row.clientPhone ?? undefined, row.clientRef ?? undefined);
          await sendWAChunked(cfg, senderPhone, msg);
        }
      }

    } else if (rawCmd === "/cliente") {
      const clientName = text.trim().slice(rawCmd.length).trim();
      if (!clientName) {
        await sendWA(cfg, senderPhone, `❌ Informe o nome.\nEx: /cliente Lucas`);
      } else {
        const msg = await buildClientMessageWA(clientName, cfg.companyId);
        await sendWAChunked(cfg, senderPhone, msg);
      }

    } else if (isVencidos) {
      const prefix = rawCmd.startsWith("/vencidos") ? "/vencidos" : "/vencido";
      const referral = (rawCmd.slice(prefix.length) + " " + text.trim().slice(rawCmd.length)).trim() || undefined;
      const msg = await buildVencidosWA(cfg.companyId, referral);
      await sendWAChunked(cfg, senderPhone, msg);

    } else if (rawCmd === "/novocliente") {
      const cId = cfg.companyId;
      if (!cId) { await sendWA(cfg, senderPhone, `❌ Empresa não configurada.`); return; }
      waConversations.set(senderPhone, { step: "nc_name", companyIdFilter: cId });
      await sendWA(cfg, senderPhone, `👤 ${b("Novo Cliente")}\n\nDigite o nome completo:\n\n${it("/cancelar para abortar")}`);

    } else if (rawCmd === "/cobranca") {
      const cId = cfg.companyId;
      if (!cId) { await sendWA(cfg, senderPhone, `❌ Empresa não configurada.`); return; }
      waConversations.set(senderPhone, { step: "client", companyIdFilter: cId });
      await sendWA(cfg, senderPhone, `📝 ${b("Nova Cobrança")}\n\nDigite o nome do cliente:\n\n${it("/cancelar para abortar")}`);

    } else if (rawCmd === "/quitacao") {
      const cId = cfg.companyId;
      if (!cId) { await sendWA(cfg, senderPhone, `❌ Empresa não configurada.`); return; }
      waConversations.set(senderPhone, { step: "qt_client", companyIdFilter: cId });
      await sendWA(cfg, senderPhone, `💳 ${b("Registrar Pagamento")}\n\nDigite o nome do cliente:\n\n${it("/cancelar para abortar")}`);

    } else if (rawCmd === "/cancelar") {
      waConversations.delete(senderPhone);
      await sendWA(cfg, senderPhone, `Nenhuma operação em andamento.`);

    } else if (rawCmd.startsWith("/") && rawCmd.length > 1) {
      // /<nome> — atalho de busca por cliente
      const inlinePart = rawCmd.slice(1);
      const spacePart  = text.trim().slice(rawCmd.length).trim();
      const clientName = (inlinePart + (spacePart ? " " + spacePart : "")).trim();
      if (!clientName) return;

      const clientConds: any[] = [ilike(clientsTable.name, `%${clientName}%`)];
      if (cfg.companyId) clientConds.push(eq(clientsTable.companyId, cfg.companyId));
      const clients = await db.select().from(clientsTable).where(and(...clientConds)).orderBy(clientsTable.name);

      if (clients.length === 0) {
        await sendWA(cfg, senderPhone, `❌ Nenhum cliente encontrado com o nome ${b(clientName)}.`);
      } else if (clients.length === 1) {
        const client = clients[0];
        const invoices = await db.select().from(invoicesTable)
          .where(eq(invoicesTable.clientId, client.id)).orderBy(invoicesTable.dueDate);
        if (invoices.length <= 1) {
          const msg = await buildClientMessageWA(clientName, cfg.companyId);
          await sendWAChunked(cfg, senderPhone, msg);
        } else {
          const today = new Date(); today.setUTCHours(0, 0, 0, 0);
          const phoneTag = client.phone ? ` | ${client.phone}` : "";
          const refTag = client.referralSource && client.referralSource !== "invite_link" ? `\n🔗 Indicação: ${client.referralSource}` : "";
          const overdueCount = invoices.filter(i => i.status === "overdue").reduce((sum, i) => {
            if (!i.dueDate) return sum + 1;
            const dl = Math.max(0, Math.floor((today.getTime() - new Date(i.dueDate + "T00:00:00Z").getTime()) / 86_400_000));
            return sum + Math.max(1, Math.floor(dl / 30));
          }, 0);
          const overdueTag = overdueCount > 0 ? ` | ⚠️ ${b(`${overdueCount} parcela${overdueCount > 1 ? "s" : ""} em atraso`)}` : "";
          const header = `👤 ${b(client.name)}${phoneTag}${refTag}\n📋 ${b(`${invoices.length} contratos`)}${overdueTag} — escolha um:\n\n`;

          const blocks = invoices.map((inv, i) => {
            const due = inv.dueDate ? new Date(inv.dueDate + "T00:00:00Z") : null;
            const dueFmt = due ? due.toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "—";
            const principal = parseFloat(inv.amount ?? "0") || 0;
            const feePerDay = parseFloat(inv.lateFee ?? "0") || 0;
            const daysLate = inv.status === "overdue" && due
              ? Math.max(0, Math.floor((today.getTime() - due.getTime()) / 86_400_000)) : 0;
            const multa = feePerDay * daysLate;
            const statusLabel = STATUS_LABEL[inv.status] ?? inv.status;
            const numTag = i < NUM_EMOJI.length ? NUM_EMOJI[i] : `${i + 1}.`;
            let block = `${numTag} ${b(statusLabel)} — ${dueFmt}\n💰 Principal: ${fmtBRL(principal)}`;
            if (daysLate > 0) block += `\n⏳ ${daysLate} dias de atraso`;
            if (multa > 0)    block += `\n⚠️ Multa: ${fmtBRL(multa)}`;
            block += `\n\n📝 ${b("Observação:")}\n`;
            block += inv.notes ? inv.notes : "Nenhuma observação cadastrada.";
            if (inv.notes && inv.notesUpdatedAt) {
              const d = new Date(inv.notesUpdatedAt);
              block += `\n${it(`Atualizado em ${d.toLocaleDateString("pt-BR", { timeZone: "UTC" })}`)}`;
            }
            block += `\n\n────────────────────`;
            return block;
          });

          const footer = `\nDigite o número do contrato ou /cancelar:`;
          waConversations.set(senderPhone, { step: "cs_select_invoice", companyIdFilter: cfg.companyId, cs_clientName: client.name, cs_clientPhone: client.phone ?? undefined, cs_clientRef: client.referralSource ?? undefined, cs_invoices: invoices });

          let currentMsg = header;
          for (let b2 = 0; b2 < blocks.length; b2++) {
            const isLast = b2 === blocks.length - 1;
            const chunk = blocks[b2] + (isLast ? footer : "\n\n");
            if (currentMsg !== header && currentMsg.length + chunk.length > 3500) {
              await sendWA(cfg, senderPhone, currentMsg.trimEnd());
              currentMsg = chunk;
            } else {
              currentMsg += chunk;
            }
          }
          if (currentMsg.trim()) await sendWA(cfg, senderPhone, currentMsg.trimEnd());
        }
      } else {
        const msg = await buildClientMessageWA(clientName, cfg.companyId);
        await sendWAChunked(cfg, senderPhone, msg);
      }
    }
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
    const exists = Array.isArray(instances) && instances.some((i: any) => i.instance?.instanceName === cfg.instance);

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
