import { useState } from "react";
import { useListDebts, getListDebtsQueryKey, useUpdateDebt, getGetDashboardSummaryQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ShieldAlert, CheckCircle2, XCircle, CircleCheck, Landmark, Clock, CalendarDays } from "lucide-react";
import { formatCurrency } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";

const PERIOD_DAYS: Record<string, number> = { daily: 1, weekly: 7, biweekly: 14, monthly: 30 };

function calcOverdueInstallments(
  daysOverdue: number,
  dueDate: string | null | undefined,
  recurrence: string | null | undefined,
): { count: number; dates: string[] } {
  if (!dueDate || daysOverdue <= 0) return { count: 0, dates: [] };
  const periodDays = recurrence ? (PERIOD_DAYS[recurrence] ?? 0) : 0;
  const count = periodDays > 0 ? Math.max(1, Math.floor(daysOverdue / periodDays)) : 1;
  const dates: string[] = [];
  const start = new Date(dueDate + "T12:00:00Z");
  for (let i = 0; i < count; i++) {
    const d = new Date(start);
    if (recurrence === "monthly") {
      d.setUTCMonth(d.getUTCMonth() + i);
    } else {
      d.setUTCDate(d.getUTCDate() + i * (periodDays || 1));
    }
    dates.push(d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }));
  }
  return { count, dates };
}

const FILTER_TABS = [
  { value: "open"   as const, label: "Em aberto" },
  { value: "closed" as const, label: "Encerradas" },
  { value: "all"    as const, label: "Todas" },
];

export default function Debts() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<"open" | "closed" | "all">("open");
  const [closeId, setCloseId] = useState<number | null>(null);

  const debtParams = statusFilter !== "all" ? { status: statusFilter } : undefined;
  const { data: debts, isLoading } = useListDebts(debtParams);

  const updateDebt = useUpdateDebt();

  const confirmClose = () => {
    if (closeId === null) return;
    updateDebt.mutate(
      { id: closeId, data: { status: "closed" } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListDebtsQueryKey(debtParams) });
          queryClient.invalidateQueries({ queryKey: getListDebtsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          setCloseId(null);
          toast({ title: "Dívida encerrada com sucesso" });
        },
      }
    );
  };

  const openDebts  = debts?.filter((d) => d.status === "open") ?? [];
  const closedDebts = debts?.filter((d) => d.status === "closed") ?? [];
  const totalOpen  = openDebts.reduce((s, d) => {
    const multa = (d.invoiceLateFee ?? 0) * (d.daysOverdue ?? 0);
    return s + (d.invoiceAmount ?? 0) + multa;
  }, 0);
  const totalClosed = closedDebts.reduce((s, d) => s + (d.invoiceAmount ?? 0), 0);

  const urgentCount  = openDebts.filter((d) => d.daysOverdue > 30).length;
  const recentCount  = openDebts.filter((d) => d.daysOverdue <= 5).length;

  return (
    <AppLayout>
      {/* HEADER */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-7">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-7 h-7 rounded-lg bg-destructive/15 border border-destructive/25 flex items-center justify-center">
              <ShieldAlert className="h-3.5 w-3.5 text-destructive" />
            </div>
            <h1 className="text-2xl font-bold">Controle de Dívidas</h1>
          </div>
          <p className="text-muted-foreground text-sm">
            Cobranças em atraso, dias vencidos e encerramento de contratos
          </p>
        </div>
      </div>

      {/* KPI CARDS */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-7">
        <Card className={openDebts.length > 0 ? "border-destructive/20 bg-destructive/5" : "border-border/60"}>
          <div className="p-4 flex items-center gap-3">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${openDebts.length > 0 ? "bg-destructive/15" : "bg-muted"}`}>
              <XCircle className={`h-4 w-4 ${openDebts.length > 0 ? "text-destructive" : "text-muted-foreground"}`} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Em aberto</p>
              <p className={`text-xl font-bold tabular-nums ${openDebts.length > 0 ? "text-destructive" : ""}`}>
                {isLoading ? "—" : openDebts.length}
              </p>
            </div>
          </div>
        </Card>

        <Card className={totalOpen > 0 ? "border-destructive/20 bg-destructive/5" : "border-border/60"}>
          <div className="p-4 flex items-center gap-3">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${totalOpen > 0 ? "bg-destructive/15" : "bg-muted"}`}>
              <Landmark className={`h-4 w-4 ${totalOpen > 0 ? "text-destructive" : "text-muted-foreground"}`} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total a cobrar</p>
              <p className={`text-base font-bold tabular-nums leading-tight mt-0.5 ${totalOpen > 0 ? "text-destructive" : ""}`}>
                {isLoading ? "—" : formatCurrency(totalOpen)}
              </p>
            </div>
          </div>
        </Card>

        <Card className={urgentCount > 0 ? "border-amber-500/20 bg-amber-500/5" : "border-border/60"}>
          <div className="p-4 flex items-center gap-3">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${urgentCount > 0 ? "bg-amber-500/15" : "bg-muted"}`}>
              <Clock className={`h-4 w-4 ${urgentCount > 0 ? "text-amber-500" : "text-muted-foreground"}`} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">+30 dias atraso</p>
              <p className={`text-xl font-bold tabular-nums ${urgentCount > 0 ? "text-amber-500" : ""}`}>
                {isLoading ? "—" : urgentCount}
              </p>
            </div>
          </div>
        </Card>

        <Card className="border-emerald-500/20 bg-emerald-500/5">
          <div className="p-4 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/15 flex items-center justify-center shrink-0">
              <CircleCheck className="h-4 w-4 text-emerald-500" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Encerradas</p>
              <p className="text-xl font-bold tabular-nums text-emerald-500">
                {isLoading ? "—" : closedDebts.length}
              </p>
            </div>
          </div>
        </Card>
      </div>

      {/* FILTROS */}
      <div className="flex gap-2 mb-5">
        {FILTER_TABS.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => setStatusFilter(value)}
            data-testid={`button-filter-${value}`}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors border ${
              statusFilter === value
                ? "bg-foreground text-background border-foreground"
                : "bg-transparent text-muted-foreground border-border hover:border-foreground/40 hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* TABELA */}
      {isLoading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      ) : !debts || debts.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16 text-center">
            <ShieldAlert className="h-10 w-10 text-muted-foreground mb-3 opacity-40" />
            <p className="font-medium text-muted-foreground">
              {statusFilter === "open" ? "Nenhuma dívida em aberto" : "Nenhuma dívida encontrada"}
            </p>
            {statusFilter === "open" && (
              <p className="text-sm text-muted-foreground/70 mt-1">
                Dívidas aparecem automaticamente quando cobranças são marcadas como vencidas
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full min-w-[500px]">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground bg-muted/30">
                  <th className="px-5 py-3 font-medium">Cliente</th>
                  <th className="px-5 py-3 font-medium">Total (c/ multa)</th>
                  <th className="px-5 py-3 font-medium">Dias em Atraso</th>
                  <th className="px-5 py-3 font-medium">Parcelas Atrasadas</th>
                  <th className="px-5 py-3 font-medium">Situação</th>
                  <th className="px-5 py-3 font-medium text-right">Ação</th>
                </tr>
              </thead>
              <tbody>
                {debts.map((debt) => {
                  const isUrgent = debt.daysOverdue > 30;
                  const { count: overdueCount, dates: overdueDates } = calcOverdueInstallments(
                    debt.daysOverdue,
                    debt.invoiceDueDate,
                    debt.invoiceRecurrence,
                  );

                  return (
                    <tr
                      key={debt.id}
                      className="border-b border-border last:border-0 hover:bg-accent/40 transition-colors group"
                      data-testid={`row-debt-${debt.id}`}
                    >
                      <td className="px-5 py-3.5 font-medium text-sm">
                        {debt.clientName ?? `Cliente #${debt.clientId}`}
                      </td>

                      <td className="px-5 py-3.5 text-sm tabular-nums">
                        {debt.invoiceAmount != null ? (
                          <div>
                            {(() => {
                              const multa = (debt.invoiceLateFee ?? 0) * (debt.daysOverdue ?? 0);
                              const total = debt.invoiceAmount + multa;
                              if (debt.status === "open" && multa > 0) {
                                return (
                                  <div>
                                    <span className="font-bold text-destructive">{formatCurrency(total)}</span>
                                    <div className="text-xs text-muted-foreground mt-0.5 space-y-0.5">
                                      <div>Principal: {formatCurrency(debt.invoiceAmount)}</div>
                                      <div className="text-destructive/80">
                                        Multa: {debt.daysOverdue}d × {formatCurrency(debt.invoiceLateFee)} = {formatCurrency(multa)}
                                      </div>
                                    </div>
                                  </div>
                                );
                              }
                              return (
                                <span className={`font-bold ${debt.status === "open" ? "text-destructive" : "text-muted-foreground"}`}>
                                  {formatCurrency(debt.invoiceAmount)}
                                </span>
                              );
                            })()}
                          </div>
                        ) : <span className="opacity-40">—</span>}
                      </td>

                      <td className="px-5 py-3.5 text-sm">
                        {debt.status === "open" ? (
                          debt.daysOverdue === 0 ? (
                            <span className="inline-flex items-center gap-1.5 text-amber-500 font-medium">
                              <Clock className="h-3.5 w-3.5" />
                              Hoje
                            </span>
                          ) : (
                            <span className={`font-semibold tabular-nums ${isUrgent ? "text-destructive" : "text-amber-500"}`}>
                              {debt.daysOverdue} {debt.daysOverdue === 1 ? "dia" : "dias"}
                            </span>
                          )
                        ) : (
                          <span className="text-muted-foreground opacity-50">—</span>
                        )}
                      </td>

                      <td className="px-5 py-3.5 text-sm">
                        {debt.status === "open" && overdueCount > 0 ? (
                          <div className="space-y-1">
                            <div className="flex items-center gap-1.5">
                              <CalendarDays className="h-3.5 w-3.5 text-destructive shrink-0" />
                              <span className={`font-bold tabular-nums ${isUrgent ? "text-destructive" : "text-amber-500"}`}>
                                {overdueCount} {overdueCount === 1 ? "parcela" : "parcelas"}
                              </span>
                            </div>
                            <div className="flex flex-col gap-0.5 pl-5">
                              {overdueDates.slice(0, 5).map((d, i) => (
                                <span key={i} className="text-xs text-muted-foreground tabular-nums">{d}</span>
                              ))}
                              {overdueDates.length > 5 && (
                                <span className="text-xs text-muted-foreground/60">+{overdueDates.length - 5} mais...</span>
                              )}
                            </div>
                          </div>
                        ) : (
                          <span className="text-muted-foreground opacity-40">—</span>
                        )}
                      </td>

                      <td className="px-5 py-3.5" data-testid={`status-debt-${debt.id}`}>
                        {debt.status === "open" ? (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-destructive/10 text-destructive border border-destructive/25">
                            <XCircle className="h-3 w-3" />
                            Em aberto
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-emerald-500/10 text-emerald-500 border border-emerald-500/25">
                            <CircleCheck className="h-3 w-3" />
                            Encerrada
                          </span>
                        )}
                      </td>

                      <td className="px-5 py-3.5 text-right">
                        {debt.status === "open" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setCloseId(debt.id)}
                            data-testid={`button-close-debt-${debt.id}`}
                            className="h-7 text-emerald-500 hover:text-emerald-600 hover:bg-emerald-500/10 text-xs gap-1.5 px-2 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Encerrar
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Rodapé com total */}
            {statusFilter !== "closed" && openDebts.length > 0 && (
              <div className="border-t border-border bg-muted/20 px-5 py-3 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{openDebts.length} {openDebts.length === 1 ? "dívida em aberto" : "dívidas em aberto"}</span>
                <span className="text-sm font-bold text-destructive tabular-nums">{formatCurrency(totalOpen)}</span>
              </div>
            )}
            {statusFilter === "closed" && closedDebts.length > 0 && (
              <div className="border-t border-border bg-muted/20 px-5 py-3 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{closedDebts.length} {closedDebts.length === 1 ? "dívida encerrada" : "dívidas encerradas"}</span>
                <span className="text-sm font-bold text-emerald-500 tabular-nums">{formatCurrency(totalClosed)}</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* AlertDialog — Encerrar */}
      <AlertDialog open={closeId !== null} onOpenChange={(o) => !o && setCloseId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Encerrar dívida?</AlertDialogTitle>
            <AlertDialogDescription>
              Confirme que esta dívida foi resolvida. Ela será marcada como encerrada e sairá da lista de cobrança ativa.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={confirmClose}>Encerrar dívida</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
