import { useState } from "react";
import {
  useListCashFlow, getListCashFlowQueryKey,
  useCreateCashFlowEntry, useDeleteCashFlowEntry,
  useGetCashFlowByCategory, getGetCashFlowByCategoryQueryKey,
  useListInvoices,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useForm } from "react-hook-form";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Plus, Trash2, ArrowDownLeft, ArrowUpRight, Wallet,
  TrendingUp, LayoutList, Filter,
} from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";

interface CashFlowFormData {
  type: "income" | "expense";
  amount: string;
  description: string;
  category: string;
  date: string;
}

const TYPE_LABEL: Record<string, string> = {
  income: "Recebimento",
  expense: "Empréstimo",
};

export default function CashFlow() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [typeFilter, setTypeFilter] = useState<"income" | "expense" | "all">("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const { data: entries, isLoading } = useListCashFlow(
    typeFilter !== "all" ? { type: typeFilter } : undefined,
    { query: { queryKey: getListCashFlowQueryKey(typeFilter !== "all" ? { type: typeFilter } : undefined) } }
  );

  const { data: byCategory } = useGetCashFlowByCategory({
    query: { queryKey: getGetCashFlowByCategoryQueryKey() },
  });

  const createEntry = useCreateCashFlowEntry();
  const deleteEntry = useDeleteCashFlowEntry();

  const form = useForm<CashFlowFormData>({
    defaultValues: {
      type: "income",
      amount: "",
      description: "",
      category: "",
      date: new Date().toISOString().split("T")[0],
    },
  });

  const totalExpense = entries?.filter((e) => e.type === "expense").reduce((s, e) => s + Number(e.amount), 0) ?? 0;

  // Recuperado = soma dos valores principais de cobranças quitadas (pagas) no mês atual
  const { data: paidInvoices } = useListInvoices({ status: "paid" });
  const now = new Date();
  const thisMonth = now.getMonth();
  const thisYear = now.getFullYear();

  const recuperado = (paidInvoices ?? []).reduce((sum, inv) => {
    if (!inv.dueDate) return sum + (inv.amount ?? 0);
    const due = new Date(inv.dueDate);
    if (due.getMonth() === thisMonth && due.getFullYear() === thisYear) {
      return sum + (inv.amount ?? 0);
    }
    return sum;
  }, 0);

  // Resultado Operacional = soma dos juros de cobranças pendentes/em dia com vencimento no mês atual
  const { data: pendingInvoices } = useListInvoices({ status: "pending" });
  const { data: currentInvoices } = useListInvoices({ status: "current" });
  const { data: requestedInvoices } = useListInvoices({ status: "requested" });

  const allActiveInvoices = [
    ...(pendingInvoices ?? []),
    ...(currentInvoices ?? []),
    ...(requestedInvoices ?? []),
  ];

  // Emprestado = total de todos os valores ativos na rua (todos os clientes)
  const totalEmprestado = allActiveInvoices.reduce((sum, inv) => sum + (inv.amount ?? 0), 0);

  const activeDueThisMonth = allActiveInvoices.filter((inv) => {
    if (!inv.dueDate) return false;
    const due = new Date(inv.dueDate);
    return due.getMonth() === thisMonth && due.getFullYear() === thisYear;
  });

  const resultadoOperacional = activeDueThisMonth.reduce((sum, inv) => {
    const interest = ((inv.amount ?? 0) * (inv.interestRate ?? 0)) / 100;
    return sum + interest;
  }, 0);

  const onSubmit = (data: CashFlowFormData) => {
    createEntry.mutate(
      {
        data: {
          type: data.type,
          amount: parseFloat(data.amount.replace(",", ".")),
          description: data.description || undefined,
          category: data.category || undefined,
          date: data.date ? new Date(data.date).toISOString() : undefined,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCashFlowQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetCashFlowByCategoryQueryKey() });
          setDialogOpen(false);
          form.reset();
          toast({ title: "Movimentação registrada" });
        },
      }
    );
  };

  const confirmDelete = () => {
    if (deleteId === null) return;
    deleteEntry.mutate(
      { id: deleteId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCashFlowQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetCashFlowByCategoryQueryKey() });
          setDeleteId(null);
          toast({ title: "Movimentação removida" });
        },
      }
    );
  };

  return (
    <AppLayout>
      {/* HEADER */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-7">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-7 h-7 rounded-lg bg-emerald-500/15 border border-emerald-500/25 flex items-center justify-center">
              <Wallet className="h-3.5 w-3.5 text-emerald-500" />
            </div>
            <h1 className="text-2xl font-bold">Movimentação da Carteira</h1>
          </div>
          <p className="text-muted-foreground text-sm">
            Controle de recebimentos, empréstimos e saldo operacional
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)} data-testid="button-add-entry" className="gap-2">
          <Plus className="h-4 w-4" />
          Registrar Movimentação
        </Button>
      </div>

      {/* KPI CARDS */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-7">
        {/* Recuperado */}
        <Card className="border-emerald-500/20 bg-emerald-500/5 relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/5 to-transparent pointer-events-none" />
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Recuperado</CardTitle>
            <div className="w-7 h-7 rounded-lg bg-emerald-500/15 flex items-center justify-center">
              <ArrowDownLeft className="h-3.5 w-3.5 text-emerald-500" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-500">{formatCurrency(recuperado)}</div>
            <p className="text-xs text-muted-foreground mt-1">quitações recebidas este mês</p>
          </CardContent>
        </Card>

        {/* Emprestado */}
        <Card className="border-destructive/20 bg-destructive/5 relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-destructive/5 to-transparent pointer-events-none" />
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Emprestado</CardTitle>
            <div className="w-7 h-7 rounded-lg bg-destructive/15 flex items-center justify-center">
              <ArrowUpRight className="h-3.5 w-3.5 text-destructive" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">{formatCurrency(totalEmprestado)}</div>
            <p className="text-xs text-muted-foreground mt-1">total na rua ({allActiveInvoices.length} clientes)</p>
          </CardContent>
        </Card>

        {/* Resultado Operacional */}
        <Card className="border-emerald-500/20 relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/5 to-transparent pointer-events-none" />
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Resultado Operacional</CardTitle>
            <div className="w-7 h-7 rounded-lg bg-emerald-500/15 flex items-center justify-center">
              <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-500">
              {formatCurrency(resultadoOperacional)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              juros previstos este mês ({activeDueThisMonth.length} cobranças)
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* TABELA OPERACIONAL */}
        <div className="lg:col-span-2">
          <div className="flex justify-between items-center mb-4">
            <div className="flex items-center gap-2">
              <LayoutList className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-base font-semibold">Operações</h2>
            </div>
            <div className="flex items-center gap-2">
              <Filter className="h-3.5 w-3.5 text-muted-foreground" />
              <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as any)}>
                <SelectTrigger className="w-40 h-8 text-sm" data-testid="select-type-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os tipos</SelectItem>
                  <SelectItem value="income">Recebimentos</SelectItem>
                  <SelectItem value="expense">Empréstimos</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {isLoading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : !entries || entries.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center py-12 text-center">
                <Wallet className="h-10 w-10 text-muted-foreground mb-3 opacity-40" />
                <p className="font-medium text-muted-foreground">Nenhuma movimentação encontrada</p>
                <p className="text-sm text-muted-foreground/70 mt-1">Registre um recebimento ou empréstimo para começar</p>
              </CardContent>
            </Card>
          ) : (
            <Card className="overflow-hidden">
              <CardContent className="p-0 overflow-x-auto">
                <table className="w-full min-w-[500px]">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground bg-muted/30">
                      <th className="px-5 py-3 font-medium">Data</th>
                      <th className="px-5 py-3 font-medium">Descrição</th>
                      <th className="px-5 py-3 font-medium">Categoria</th>
                      <th className="px-5 py-3 font-medium">Tipo</th>
                      <th className="px-5 py-3 font-medium text-right">Valor</th>
                      <th className="px-5 py-3 font-medium text-right">Ação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => (
                      <tr
                        key={entry.id}
                        className="border-b border-border last:border-0 hover:bg-accent/40 transition-colors group"
                        data-testid={`row-entry-${entry.id}`}
                      >
                        <td className="px-5 py-3.5 text-sm text-muted-foreground whitespace-nowrap">
                          {formatDate(entry.date)}
                        </td>
                        <td className="px-5 py-3.5 text-sm font-medium">
                          {entry.description ?? <span className="text-muted-foreground/50">—</span>}
                        </td>
                        <td className="px-5 py-3.5 text-sm text-muted-foreground">
                          {entry.category ?? <span className="opacity-40">—</span>}
                        </td>
                        <td className="px-5 py-3.5" data-testid={`type-entry-${entry.id}`}>
                          {entry.type === "income" ? (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-emerald-500/10 text-emerald-500 border border-emerald-500/25">
                              <ArrowDownLeft className="h-3 w-3" />
                              Recebimento
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-destructive/10 text-destructive border border-destructive/25">
                              <ArrowUpRight className="h-3 w-3" />
                              Empréstimo
                            </span>
                          )}
                        </td>
                        <td className={`px-5 py-3.5 text-right font-bold tabular-nums whitespace-nowrap ${entry.type === "income" ? "text-emerald-500" : "text-destructive"}`}>
                          {entry.type === "expense" ? "-" : "+"}{formatCurrency(Number(entry.amount))}
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={() => setDeleteId(entry.id)}
                            data-testid={`button-delete-entry-${entry.id}`}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </div>

        {/* POR OPERAÇÃO */}
        <div>
          <div className="flex items-center gap-2 mb-4">
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-base font-semibold">Por Categoria</h2>
          </div>
          <Card>
            <CardContent className="p-4 space-y-1">
              {!byCategory || byCategory.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6 opacity-60">Sem movimentações</p>
              ) : (
                byCategory.map((item, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between py-2.5 border-b border-border last:border-0"
                  >
                    <div>
                      <p className="text-sm font-medium">{item.category ?? "Sem categoria"}</p>
                      <span className={`inline-flex items-center gap-1 text-xs mt-0.5 ${item.type === "income" ? "text-emerald-500" : "text-destructive"}`}>
                        {item.type === "income"
                          ? <><ArrowDownLeft className="h-3 w-3" /> Recebimento</>
                          : <><ArrowUpRight className="h-3 w-3" /> Empréstimo</>}
                      </span>
                    </div>
                    <span className={`font-bold tabular-nums ${item.type === "income" ? "text-emerald-500" : "text-destructive"}`}>
                      {formatCurrency(Number(item.total))}
                    </span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* DIALOG — Registrar */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Registrar Movimentação</DialogTitle>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div>
              <Label>Tipo de operação</Label>
              <Select value={form.watch("type")} onValueChange={(v) => form.setValue("type", v as any)}>
                <SelectTrigger data-testid="select-entry-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="income">Recebimento (dinheiro que voltou)</SelectItem>
                  <SelectItem value="expense">Empréstimo (dinheiro que saiu)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="amount">Valor (R$) *</Label>
              <Input id="amount" placeholder="0,00" {...form.register("amount", { required: true })} data-testid="input-entry-amount" />
            </div>
            <div>
              <Label htmlFor="description">Descrição</Label>
              <Input id="description" placeholder="Ex: Pagamento parcela 3/12 — João Silva" {...form.register("description")} data-testid="input-entry-description" />
            </div>
            <div>
              <Label htmlFor="category">Categoria</Label>
              <Input id="category" placeholder="Ex: Parcela, Juros, Multa, Novo contrato..." {...form.register("category")} data-testid="input-entry-category" />
            </div>
            <div>
              <Label htmlFor="date">Data</Label>
              <Input id="date" type="date" {...form.register("date")} data-testid="input-entry-date" />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button>
              <Button type="submit" disabled={createEntry.isPending} data-testid="button-submit-entry">Registrar</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ALERT — Confirmar exclusão */}
      <AlertDialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover movimentação?</AlertDialogTitle>
            <AlertDialogDescription>Esta ação não pode ser desfeita.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Remover</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
