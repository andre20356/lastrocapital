import { db, invoicesTable } from "@workspace/db";
import { eq, and, isNotNull, isNull, ne } from "drizzle-orm";
import { logger } from "../lib/logger";

// Soma 1 mês preservando o dia original sempre que o mês de destino permitir.
// setUTCMonth() sozinho estoura pro mês seguinte quando o dia não existe no mês de
// destino (ex.: 31/05 + 1 mês vira 01/07 em vez de 30/06), pulando um mês inteiro
// e criando parcelas com data e valor que não correspondem a nenhum vencimento real.
function addMonthSafe(date: Date): Date {
  const day = date.getUTCDate();
  const next = new Date(date);
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const lastDayOfNextMonth = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDayOfNextMonth));
  return next;
}

function addPeriod(date: Date, recurrence: string): Date {
  const next = new Date(date);
  switch (recurrence) {
    case "monthly":   return addMonthSafe(next);
    case "biweekly":  next.setUTCDate(next.getUTCDate() + 14);  break;
    case "weekly":    next.setUTCDate(next.getUTCDate() + 7);   break;
    case "daily":     next.setUTCDate(next.getUTCDate() + 1);   break;
    default:          return addMonthSafe(next);
  }
  return next;
}

export async function generateRecurringInvoices(): Promise<void> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const overdueInvoices = await db
    .select()
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.status, "overdue"),
        isNotNull(invoicesTable.recurrence),
        isNotNull(invoicesTable.dueDate),
        ne(invoicesTable.recurrence, ""),
      ),
    );

  // Um contrato recorrente pode ter várias parcelas "overdue" em aberto ao mesmo tempo
  // (ex.: cliente inadimplente há meses). Usamos apenas a parcela mais recente de cada
  // contrato como origem do backfill — caso contrário cada parcela já gerada por uma
  // execução anterior vira uma nova origem na execução seguinte, multiplicando as
  // parcelas geradas a cada dia.
  //
  // Um mesmo cliente pode ter VÁRIOS contratos simultâneos e independentes (cada um
  // identificado pela "nota" — ex. "Ref. Eduarda", "Ref. Kamilly"). Agrupar só por
  // cliente faz a função tratar um contrato qualquer como se fosse "a" recorrência do
  // cliente inteiro e gerar parcelas fantasmas de outro contrato. Por isso o agrupamento
  // inclui a nota — cada contrato mantém sua própria cadeia de recorrência.
  const latestByContract = new Map<string, (typeof overdueInvoices)[number]>();
  for (const inv of overdueInvoices) {
    if (!inv.dueDate) continue;
    const key = `${inv.companyId}-${inv.clientId}-${inv.notes ?? ""}`;
    const current = latestByContract.get(key);
    if (!current || !current.dueDate || inv.dueDate > current.dueDate) {
      latestByContract.set(key, inv);
    }
  }

  let generated = 0;

  for (const inv of latestByContract.values()) {
    if (!inv.dueDate || !inv.recurrence) continue;

    let cursor = new Date(inv.dueDate + "T00:00:00Z");
    let nextDue = addPeriod(cursor, inv.recurrence);

    // Gera todas as parcelas em falta até hoje
    while (nextDue <= today) {
      const nextDueStr = nextDue.toISOString().slice(0, 10);

      const notesCondition = inv.notes
        ? eq(invoicesTable.notes, inv.notes)
        : isNull(invoicesTable.notes);

      const [existing] = await db
        .select({ id: invoicesTable.id })
        .from(invoicesTable)
        .where(
          and(
            eq(invoicesTable.clientId, inv.clientId),
            eq(invoicesTable.companyId, inv.companyId),
            eq(invoicesTable.dueDate, nextDueStr),
            notesCondition,
          ),
        )
        .limit(1);

      if (!existing) {
        await db.insert(invoicesTable).values({
          clientId:     inv.clientId,
          companyId:    inv.companyId,
          amount:       inv.amount,
          dueDate:      nextDueStr,
          status:       "overdue",
          interestRate: inv.interestRate,
          lateFee:      inv.lateFee,
          recurrence:   inv.recurrence,
          daysLate:     0,
          interestPaid: false,
          notes:        inv.notes,
        });
        generated++;
        logger.info(`[AutoInvoice] Parcela gerada: cliente ${inv.clientId}, venc. ${nextDueStr}${inv.notes ? ` (${inv.notes})` : ""}`);
      }

      cursor  = nextDue;
      nextDue = addPeriod(cursor, inv.recurrence);
    }
  }

  if (generated > 0) {
    logger.info(`[AutoInvoice] ${generated} parcela(s) gerada(s) automaticamente`);
  } else {
    logger.info("[AutoInvoice] Nenhuma parcela nova a gerar");
  }
}
