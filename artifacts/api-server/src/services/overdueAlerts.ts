import { eq, and, lt, notInArray, sql } from "drizzle-orm";
import { db, clientsTable, invoicesTable, companiesTable } from "@workspace/db";
import { calculateInvoiceBreakdown } from "./invoiceCalculator";
import { sendWA, empresaWhatsAppConectado } from "./whatsappCommands";
import { logger } from "../lib/logger";

const fmt = (v: number) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const fmtDate = (d: string | null) => {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
};

export type AlertaResultado =
  | { ok: true; sentTo: string; clientName: string }
  | { ok: false; motivo: string };

// Monta a mensagem de aviso de atraso (todos os contratos overdue do cliente,
// detalhados um a um) e envia via WhatsApp. Usada tanto pelo botão manual
// (POST /clients/:id/send-overdue-alert) quanto pela cobrança diária automática.
export async function montarEEnviarAlertaAtraso(
  companyId: number,
  clientId: number,
): Promise<AlertaResultado> {
  const [client] = await db
    .select()
    .from(clientsTable)
    .where(and(eq(clientsTable.id, clientId), eq(clientsTable.companyId, companyId)));

  if (!client) return { ok: false, motivo: "Cliente não encontrado" };
  if (!client.phone) return { ok: false, motivo: "Cliente sem telefone cadastrado" };

  // Usa a data de vencimento real em vez do campo status: algumas faturas já
  // vencidas nunca foram viradas manualmente pra "overdue" no painel (achado
  // real: 9 faturas vencidas ainda marcadas "current"/"requested" em 2026-07-03)
  // — sem isso, essas ficariam de fora do aviso e da cobrança diária.
  const overdue = await db
    .select()
    .from(invoicesTable)
    .where(and(
      eq(invoicesTable.companyId, companyId),
      eq(invoicesTable.clientId, clientId),
      lt(invoicesTable.dueDate, sql`CURRENT_DATE`),
      notInArray(invoicesTable.status, ["paid", "requested"]),
    ))
    .orderBy(invoicesTable.dueDate);

  if (overdue.length === 0) return { ok: false, motivo: "Cliente não possui faturas em atraso" };

  const [company] = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId));

  if (!company?.whatsappInstance) {
    return { ok: false, motivo: "WhatsApp da empresa não está conectado" };
  }
  if (!(await empresaWhatsAppConectado(company))) {
    return { ok: false, motivo: "WhatsApp da empresa não está conectado" };
  }

  let grandTotal = 0;

  const contractLines = overdue.map((inv, i) => {
    // Sempre calcula os dias reais pela data de vencimento vs hoje
    // Taxa de atraso só começa após 2 dias de carência
    const GRACE_DAYS = 2;
    const totalDays = (() => {
      if (!inv.dueDate) return 0;
      const due = new Date(inv.dueDate + "T00:00:00-03:00"); // fuso Brasil
      return Math.max(0, Math.floor((Date.now() - due.getTime()) / 86_400_000));
    })();
    const realDays = Math.max(0, totalDays - GRACE_DAYS);

    // status: "overdue" força o cálculo de juros/multa mesmo quando a fatura
    // ainda está marcada "current" no banco — já confirmamos pela data que
    // está vencida de verdade, calculateInvoiceBreakdown só aplica encargos
    // se o status literal for "overdue".
    const breakdown = calculateInvoiceBreakdown({ ...inv, status: "overdue", daysLate: realDays });
    if (!breakdown) return null;

    const { principal, interestAmount, lateFeeTotal, total } = breakdown;
    const encargos = interestAmount + lateFeeTotal;
    grandTotal += total;

    const feePerDay = parseFloat(inv.lateFee ?? "0");

    return (
      `📋 *Contrato ${i + 1}* — Venc. ${fmtDate(inv.dueDate)}\n` +
      (inv.notes ? `   Nota: ${inv.notes}\n` : "") +
      `   Principal: ${fmt(principal)}\n` +
      `   Juros: ${fmt(interestAmount)}\n` +
      `   Taxa de atraso: ${fmt(feePerDay)}/dia\n` +
      `   Dias em atraso: ${totalDays} dia${totalDays !== 1 ? "s" : ""} (cobrança a partir do 3º dia)\n` +
      `   Subtotal: ${fmt(encargos)}\n` +
      `   Quitação: *${fmt(total)}*`
    );
  }).filter(Boolean).join("\n\n");

  const nomeEmpresa = company.name ?? "Nossa Empresa";

  const msg =
    `🔴 *Aviso de Atraso — ${nomeEmpresa}*\n\n` +
    `Olá, ${client.name}.\n\n` +
    `Identificamos as seguintes pendências em seu(s) contrato(s):\n\n` +
    contractLines + "\n\n" +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💰 *Total para quitação: ${fmt(grandTotal)}*\n\n` +
    `Para efetuar o pagamento, digite *menu*.\n\n` +
    `⚠️ *O envio do comprovante é obrigatório.* Sem ele, o sistema não identifica seu pagamento e taxas de atraso adicionais poderão ser geradas.\n\n` +
    `*${nomeEmpresa}*`;

  const cfg = {
    apiUrl:     process.env.EVOLUTION_SERVER_URL ?? "http://evolution:8080",
    apiKey:     process.env.EVOLUTION_API_KEY ?? "",
    instance:   company.whatsappInstance,
    adminPhone: company.whatsappPhone ?? "",
    companyId,
  };

  // whatsapp_jid (@lid) é só pra RECONHECER mensagens recebidas — pode ficar
  // desatualizado (troca de aparelho/reinstalação) sem que ninguém perceba.
  // Achado real: Michael teixeira (cliente 20) tinha @lid salvo apontando pra
  // um identificador que não existe mais na rede do WhatsApp (fetchProfile
  // retornou exists:false), enquanto o telefone continuava 100% válido e
  // confirmado como recebido. Envio sempre pelo telefone — é o único canal
  // verificável via chat/whatsappNumbers antes de mandar.
  const sentJid = await sendWA(cfg, client.phone, msg);
  if (!sentJid) return { ok: false, motivo: "Falha ao enviar mensagem via WhatsApp (ver logs de [WA])" };

  return { ok: true, sentTo: client.phone, clientName: client.name };
}

// ── Cobrança diária automática (todo cliente já vencido) ─────────────────────
// Duas fases bem separadas: quem AINDA VAI vencer recebe o lembrete de
// 7/3/1 dias (checkDueDateNotifications, telegramNotifier.ts); quem JÁ VENCEU
// entra aqui — dispara todo dia, desde o 1º dia de atraso, até o contrato
// deixar de estar vencido (pago/renegociado). Usa a data real de vencimento,
// não o campo status (ver nota em montarEEnviarAlertaAtraso).

export async function cobrarClientesAtrasoCronico(): Promise<void> {
  const companies = await db.select().from(companiesTable);

  for (const company of companies) {
    if (!(await empresaWhatsAppConectado(company))) continue;

    const vencidosDaCompany = await db
      .select({ clientId: invoicesTable.clientId })
      .from(invoicesTable)
      .where(and(
        eq(invoicesTable.companyId, company.id),
        lt(invoicesTable.dueDate, sql`CURRENT_DATE`),
        notInArray(invoicesTable.status, ["paid", "requested"]),
      ));

    const clientesElegiveis = new Set(vencidosDaCompany.map((r) => r.clientId));
    if (clientesElegiveis.size === 0) continue;

    logger.info(`[CobrancaCronica] Empresa "${company.name}" — ${clientesElegiveis.size} cliente(s) com contrato vencido`);

    for (const clientId of clientesElegiveis) {
      try {
        const r = await montarEEnviarAlertaAtraso(company.id, clientId);
        if (r.ok) {
          logger.info(`[CobrancaCronica] Enviado pra ${r.clientName} (${r.sentTo})`);
        } else {
          logger.warn(`[CobrancaCronica] Cliente ${clientId} pulado: ${r.motivo}`);
        }
      } catch (e: any) {
        logger.warn(`[CobrancaCronica] Erro ao cobrar cliente ${clientId}: ${e.message}`);
      }
    }
  }
}
