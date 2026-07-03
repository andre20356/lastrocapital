import { eq, and } from "drizzle-orm";
import { db, clientsTable, invoicesTable, companiesTable } from "@workspace/db";
import { calculateInvoiceBreakdown } from "./invoiceCalculator";
import { sendWA } from "./whatsappCommands";
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

  const overdue = await db
    .select()
    .from(invoicesTable)
    .where(and(
      eq(invoicesTable.companyId, companyId),
      eq(invoicesTable.clientId, clientId),
      eq(invoicesTable.status, "overdue"),
    ));

  if (overdue.length === 0) return { ok: false, motivo: "Cliente não possui faturas em atraso" };

  const [company] = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId));

  if (!company?.whatsappInstance || company.whatsappStatus !== "connected") {
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

    const breakdown = calculateInvoiceBreakdown({ ...inv, daysLate: realDays });
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
      `   Total encargos: ${fmt(encargos)}\n` +
      `   Subtotal: *${fmt(total)}*`
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

  await sendWA(cfg, client.phone, msg);

  return { ok: true, sentTo: client.phone, clientName: client.name };
}

// ── Cobrança diária automática (contratos vencidos há mais de X dias) ────────
// Não repete pra quem venceu há pouco (esse caso já é coberto pelo lembrete
// pré-vencimento em checkDueDateNotifications) — só entra em ação pra atraso
// crônico, repetindo TODO DIA até o cliente quitar ou o contrato deixar de
// aparecer como "overdue".

const DIAS_MINIMO_ATRASO_CRONICO = 30;

export async function cobrarClientesAtrasoCronico(): Promise<void> {
  const companies = await db.select().from(companiesTable);

  const hoje = new Date();
  hoje.setUTCHours(0, 0, 0, 0);

  for (const company of companies) {
    if (!company.whatsappInstance || company.whatsappStatus !== "connected") continue;

    const overdueDaCompany = await db
      .select()
      .from(invoicesTable)
      .where(and(
        eq(invoicesTable.companyId, company.id),
        eq(invoicesTable.status, "overdue"),
      ));

    // Agrupa por cliente — o alerta já reúne todos os contratos overdue dele
    // numa mensagem só; o gatilho é "tem PELO MENOS 1 contrato com 30+ dias".
    const clientesElegiveis = new Set<number>();
    for (const inv of overdueDaCompany) {
      if (!inv.dueDate) continue;
      const due = new Date(inv.dueDate + "T00:00:00-03:00");
      const diasAtraso = Math.floor((hoje.getTime() - due.getTime()) / 86_400_000);
      if (diasAtraso >= DIAS_MINIMO_ATRASO_CRONICO) {
        clientesElegiveis.add(inv.clientId);
      }
    }

    if (clientesElegiveis.size === 0) continue;

    logger.info(`[CobrancaCronica] Empresa "${company.name}" — ${clientesElegiveis.size} cliente(s) com atraso ≥${DIAS_MINIMO_ATRASO_CRONICO} dias`);

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
