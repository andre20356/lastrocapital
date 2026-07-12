export const formatCurrency = (value: number | null | undefined) => {
  if (value === null || value === undefined) return "R$ 0,00";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(value);
};

export const formatDate = (dateString: string | null | undefined) => {
  if (!dateString) return "-";
  const [year, month, day] = dateString.slice(0, 10).split("-").map(Number);
  return new Intl.DateTimeFormat("pt-BR").format(new Date(year, month - 1, day));
};

const PERIOD_DAYS: Record<string, number> = { daily: 1, weekly: 7, biweekly: 14 };

// Conta quantos vencimentos já ocorreram até hoje (contando o vencimento
// original como o 1º) — não dias-em-atraso ÷ 30. Espelha calcMonthsLate do
// backend (invoiceCalculator.ts); mantenha as duas em sincronia.
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

// Carência: multa só começa a contar a partir do 3º dia de atraso (2 dias de
// tolerância). Espelha billableLateDays do backend (invoiceCalculator.ts).
export const GRACE_DAYS = 2;
export function billableLateDays(daysLate: number): number {
  return Math.max(0, daysLate - GRACE_DAYS);
}
