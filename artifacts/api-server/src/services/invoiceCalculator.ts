export interface InvoiceLike {
  amount: string | null;
  status: string;
  interestRate: string | null;
  lateFee: string | null;
  daysLate?: number | null;
  interestPaid?: boolean | null;
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

  const monthsLate = days > 0 ? Math.max(1, Math.floor(days / 30)) : 1;
  const interestAmount = ((principal * rate) / 100) * monthsLate;
  const lateFeeTotal = feePerDay * days;
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
  const monthsLate = days > 0 ? Math.max(1, Math.floor(days / 30)) : 1;
  return ((principal * rate) / 100) * monthsLate + feePerDay * days;
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
