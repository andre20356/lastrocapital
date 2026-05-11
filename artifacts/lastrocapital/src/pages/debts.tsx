import { useState } from "react";
import { useListDebts, getListDebtsQueryKey, useUpdateDebt, getGetDashboardSummaryQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Landmark, CheckCircle } from "lucide-react";
import { formatCurrency } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";

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
          toast({ title: "Dívida encerrada" });
        },
      }
    );
  };

  const totalOpen = debts?.filter((d) => d.status === "open")
    .reduce((s, d) => s + (d.invoiceAmount ?? 0), 0) ?? 0;

  return (
    <AppLayout>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6 md:mb-8">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">Controle de Dívidas</h1>
          <p className="text-muted-foreground mt-1">Acompanhe cobranças em atraso</p>
        </div>
        {statusFilter === "open" && debts && debts.length > 0 && (
          <div className="text-right">
            <p className="text-sm text-muted-foreground">Total em aberto</p>
            <p className="text-2xl font-bold text-destructive">{formatCurrency(totalOpen)}</p>
          </div>
        )}
      </div>

      <div className="flex gap-3 mb-6">
        {(["open", "closed", "all"] as const).map((s) => (
          <Button
            key={s}
            variant={statusFilter === s ? "default" : "outline"}
            size="sm"
            onClick={() => setStatusFilter(s)}
            data-testid={`button-filter-${s}`}
          >
            {s === "open" ? "Em aberto" : s === "closed" ? "Encerradas" : "Todas"}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      ) : !debts || debts.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16 text-center">
            <Landmark className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">
              {statusFilter === "open"
                ? "Nenhuma dívida em aberto"
                : "Nenhuma dívida encontrada"}
            </p>
            {statusFilter === "open" && (
              <p className="text-sm text-muted-foreground mt-2">
                Dívidas aparecem quando cobranças são marcadas como vencidas
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full min-w-[500px]">
              <thead>
                <tr className="border-b border-border text-left text-sm text-muted-foreground">
                  <th className="px-6 py-4 font-medium">Cliente</th>
                  <th className="px-6 py-4 font-medium">Valor da Cobrança</th>
                  <th className="px-6 py-4 font-medium">Dias em Atraso</th>
                  <th className="px-6 py-4 font-medium">Status</th>
                  <th className="px-6 py-4 font-medium text-right">Ação</th>
                </tr>
              </thead>
              <tbody>
                {debts.map((debt) => (
                  <tr key={debt.id} className="border-b border-border last:border-0 hover:bg-accent/30 transition-colors" data-testid={`row-debt-${debt.id}`}>
                    <td className="px-6 py-4 font-medium">{debt.clientName ?? `Cliente #${debt.clientId}`}</td>
                    <td className="px-6 py-4 font-semibold">
                      {debt.invoiceAmount != null ? formatCurrency(debt.invoiceAmount) : "-"}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`font-medium ${debt.daysOverdue > 0 ? "text-destructive" : "text-muted-foreground"}`}>
                        {debt.daysOverdue > 0 ? `${debt.daysOverdue} dias` : "Hoje"}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <Badge variant={debt.status === "open" ? "destructive" : "default"} data-testid={`status-debt-${debt.id}`}>
                        {debt.status === "open" ? "Em aberto" : "Encerrada"}
                      </Badge>
                    </td>
                    <td className="px-6 py-4 text-right">
                      {debt.status === "open" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setCloseId(debt.id)}
                          data-testid={`button-close-debt-${debt.id}`}
                        >
                          <CheckCircle className="h-4 w-4 mr-2 text-emerald-500" />
                          Encerrar
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <AlertDialog open={closeId !== null} onOpenChange={(o) => !o && setCloseId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Encerrar dívida?</AlertDialogTitle>
            <AlertDialogDescription>Confirme que esta dívida foi resolvida e será marcada como encerrada.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={confirmClose}>Encerrar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
