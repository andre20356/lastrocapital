export interface InvoiceLike {
  amount: string | null;
  status: string;
  interestRate: string | null;
  lateFee: string | null;
  daysLate?: number | null;
  interestPaid?: boolean | null;
  recurrence?: string | null;
  dueDate?: string | null;
}

const PERIOD_DAYS: Record<string, number> = { daily: 1, weekly: 7, biweekly: 14 };

// Carência: multa só começa a contar a partir do 3º dia de atraso (2 dias de
// tolerância). Regra de negócio real, confirmada — precisa valer em todo
// lugar que calcula multa (painel, mensagem de cobrança, extrato do
// cliente), não só na mensagem de WhatsApp onde já existia antes.
export const GRACE_DAYS = 2;
export function billableLateDays(daysLate: number): number {
  return Math.max(0, daysLate - GRACE_DAYS);
}

// Conta quantos vencimentos já ocorreram até hoje (contando o vencimento
// original como o 1º) — não dias-em-atraso ÷ 30. Essa aproximação de 30 dias
// subestimava em até 1 mês inteiro qualquer contrato que vence depois do dia
// 1º do mês (achado real, Lucas gabriel, 2026-07-08: contratos vencidos em
// 01/06, 04/06 e 07/06 apareciam com "1 mês" quando já deviam junho E julho —
// 2 vencimentos —, enquanto o de 28/04, com 71 dias, aparecia "2" quando na
// verdade já são 3 vencimentos — abril, maio e junho). Mensal usa comparação
// de calendário (dia do mês); as demais recorrências usam dias fixos por
// período, mas também contam o vencimento original como ocorrência nº 1.
export function monthsLate(
  dueDate: string | null | undefined,
  recurrence: string | null | undefined,
  today: Date = new Date(),
): number {
  if (!dueDate) return 0;
  const due = new Date(dueDate + "T00:00:00Z");
  const now = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (now < due) return 0;

  if (recurrence && recurrence !== "monthly") {
    const periodDays = PERIOD_DAYS[recurrence] ?? 30;
    const daysLate = Math.floor((now.getTime() - due.getTime()) / 86_400_000);
    return Math.floor(daysLate / periodDays) + 1;
  }

  const monthDiff = (now.getUTCFullYear() - due.getUTCFullYear()) * 12 + (now.getUTCMonth() - due.getUTCMonth());
  return now.getUTCDate() >= due.getUTCDate() ? monthDiff + 1 : monthDiff;
}

// Avança o vencimento pro próximo período de um contrato recorrente — usado
// quando só os juros/multa foram pagos (não o principal), pra fatura sumir da
// cobrança automática (que decide por due_date, não por status) até o próximo
// vencimento. Preserva o dia original quando possível: setUTCMonth() sozinho
// estoura pro mês seguinte quando o dia não existe no mês de destino
// (ex.: 31/05 -> 01/07 em vez de 30/06).
export function advanceRecurrenceDueDate(currentDueDate: string, recurrence: string): string {
  const base = new Date(currentDueDate + "T12:00:00Z");
  if (recurrence === "monthly") {
    const day = base.getUTCDate();
    base.setUTCDate(1);
    base.setUTCMonth(base.getUTCMonth() + 1);
    const lastDayOfMonth = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
    base.setUTCDate(Math.min(day, lastDayOfMonth));
  } else if (recurrence === "weekly") {
    base.setUTCDate(base.getUTCDate() + 7);
  } else if (recurrence === "biweekly") {
    base.setUTCDate(base.getUTCDate() + 14);
  } else if (recurrence === "daily") {
    base.setUTCDate(base.getUTCDate() + 1);
  }
  return base.toISOString().split("T")[0]!;
}

export interface InvoiceBreakdown {
  principal: number;
  interestAmount: number;
  lateFeeTotal: number;
  total: number;
}

export function calculateInvoiceBreakdown(invoice: InvoiceLike): InvoiceBreakdown | null {
  if (invoice.amount == null) return null;
  const principal = parseFloat(invoice.amount);
  if (isNaN(principal)) return null;

  if (invoice.status !== "overdue" || invoice.interestPaid) {
    return { principal, interestAmount: 0, lateFeeTotal: 0, total: principal };
  }

  const rate = parseFloat(invoice.interestRate ?? "0") || 0;
  const feePerDay = parseFloat(invoice.lateFee ?? "0") || 0;
  const days = invoice.daysLate ?? 0;

  const periods = monthsLate(invoice.dueDate, invoice.recurrence);
  const interestAmount = ((principal * rate) / 100) * periods;
  const lateFeeTotal = feePerDay * billableLateDays(days);
  const total = principal + interestAmount + lateFeeTotal;

  return { principal, interestAmount, lateFeeTotal, total };
}

export function calculateInvoiceTotal(invoice: InvoiceLike): number | null {
  const breakdown = calculateInvoiceBreakdown(invoice);
  return breakdown?.total ?? null;
}

export function calculateInterestOnly(invoice: InvoiceLike): number {
  if (invoice.amount == null) return 0;
  const principal = parseFloat(invoice.amount);
  if (isNaN(principal)) return 0;
  const rate = parseFloat(invoice.interestRate ?? "0") || 0;
  const feePerDay = parseFloat(invoice.lateFee ?? "0") || 0;
  const days = invoice.daysLate ?? 0;
  const periods = monthsLate(invoice.dueDate, invoice.recurrence);
  return ((principal * rate) / 100) * periods + feePerDay * billableLateDays(days);
}

export interface EmprestimoSemanal {
  parcela: number;
  total: number;
  jurosTotal: number;
}

/**
 * Calcula parcelas de empréstimo semanal.
 * Fórmula: parcela = (P / n) + (P * r)
 *   onde r é a taxa em decimal (ex: 2% → 0.02)
 */
export function calcularEmprestimoSemanal(
  valorTotal: number,
  numeroParcelas: number,
  taxa: number
): EmprestimoSemanal {
  const base = valorTotal / numeroParcelas;
  const juros = valorTotal * taxa;
  const parcela = base + juros;
  const total = parcela * numeroParcelas;
  return {
    parcela,
    total,
    jurosTotal: juros * numeroParcelas,
  };
}
