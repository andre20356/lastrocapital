import { useState } from "react";
import {
  useListCashFlow, getListCashFlowQueryKey,
  useCreateCashFlowEntry, useDeleteCashFlowEntry,
  useGetCashFlowByCategory, getGetCashFlowByCategoryQueryKey,
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
import { Plus, Trash2, TrendingUp, TrendingDown, ArrowRightLeft } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";

interface CashFlowFormData {
  type: "income" | "expense";
  amount: string;
  description: string;
  category: string;
  date: string;
}

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
    query: { queryKey: getGetCashFlowByCategoryQueryKey() }
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

  const totalIncome = entries?.filter((e) => e.type === "income").reduce((s, e) => s + Number(e.amount), 0) ?? 0;
  const totalExpense = entries?.filter((e) => e.type === "expense").reduce((s, e) => s + Number(e.amount), 0) ?? 0;

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
          toast({ title: "Lançamento registrado" });
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
          toast({ title: "Lançamento removido" });
        },
      }
    );
  };

  return (
    <AppLayout>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">Fluxo de Caixa</h1>
          <p className="text-muted-foreground mt-1">Entradas e saídas da empresa</p>
        </div>
        <Button onClick={() => setDialogOpen(true)} data-testid="button-add-entry">
          <Plus className="h-4 w-4 mr-2" />
          Novo Lançamento
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Entradas (filtro)</CardTitle>
            <TrendingUp className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-500">{formatCurrency(totalIncome)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Saídas (filtro)</CardTitle>
            <TrendingDown className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">{formatCurrency(totalExpense)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Saldo (filtro)</CardTitle>
            <ArrowRightLeft className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${totalIncome - totalExpense >= 0 ? "text-emerald-500" : "text-destructive"}`}>
              {formatCurrency(totalIncome - totalExpense)}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold">Lançamentos</h2>
            <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as any)}>
              <SelectTrigger className="w-36" data-testid="select-type-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="income">Entradas</SelectItem>
                <SelectItem value="expense">Saídas</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {isLoading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : !entries || entries.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center py-12 text-center">
                <ArrowRightLeft className="h-10 w-10 text-muted-foreground mb-3" />
                <p className="text-muted-foreground">Nenhum lançamento encontrado</p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border text-left text-sm text-muted-foreground">
                      <th className="px-6 py-3 font-medium">Data</th>
                      <th className="px-6 py-3 font-medium">Descrição</th>
                      <th className="px-6 py-3 font-medium">Categoria</th>
                      <th className="px-6 py-3 font-medium">Tipo</th>
                      <th className="px-6 py-3 font-medium text-right">Valor</th>
                      <th className="px-6 py-3 font-medium text-right">Ação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => (
                      <tr key={entry.id} className="border-b border-border last:border-0 hover:bg-accent/30 transition-colors" data-testid={`row-entry-${entry.id}`}>
                        <td className="px-6 py-3 text-sm text-muted-foreground">{formatDate(entry.date)}</td>
                        <td className="px-6 py-3 text-sm">{entry.description ?? "-"}</td>
                        <td className="px-6 py-3 text-sm text-muted-foreground">{entry.category ?? "-"}</td>
                        <td className="px-6 py-3">
                          <Badge variant={entry.type === "income" ? "default" : "destructive"} data-testid={`type-entry-${entry.id}`}>
                            {entry.type === "income" ? "Entrada" : "Saída"}
                          </Badge>
                        </td>
                        <td className={`px-6 py-3 text-right font-semibold ${entry.type === "income" ? "text-emerald-500" : "text-destructive"}`}>
                          {entry.type === "expense" ? "-" : "+"}{formatCurrency(Number(entry.amount))}
                        </td>
                        <td className="px-6 py-3 text-right">
                          <Button variant="ghost" size="icon" onClick={() => setDeleteId(entry.id)} data-testid={`button-delete-entry-${entry.id}`}>
                            <Trash2 className="h-4 w-4 text-destructive" />
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

        <div>
          <h2 className="text-lg font-semibold mb-4">Por Categoria</h2>
          <Card>
            <CardContent className="p-4 space-y-3">
              {!byCategory || byCategory.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">Sem dados</p>
              ) : (
                byCategory.map((item, i) => (
                  <div key={i} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                    <div>
                      <p className="text-sm font-medium">{item.category ?? "Sem categoria"}</p>
                      <Badge variant={item.type === "income" ? "default" : "destructive"} className="text-xs mt-1">
                        {item.type === "income" ? "Entrada" : "Saída"}
                      </Badge>
                    </div>
                    <span className={`font-semibold ${item.type === "income" ? "text-emerald-500" : "text-destructive"}`}>
                      {formatCurrency(Number(item.total))}
                    </span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo Lançamento</DialogTitle>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div>
              <Label>Tipo</Label>
              <Select value={form.watch("type")} onValueChange={(v) => form.setValue("type", v as any)}>
                <SelectTrigger data-testid="select-entry-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="income">Entrada</SelectItem>
                  <SelectItem value="expense">Saída</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="amount">Valor (R$) *</Label>
              <Input id="amount" placeholder="0,00" {...form.register("amount", { required: true })} data-testid="input-entry-amount" />
            </div>
            <div>
              <Label htmlFor="description">Descrição</Label>
              <Input id="description" {...form.register("description")} data-testid="input-entry-description" />
            </div>
            <div>
              <Label htmlFor="category">Categoria</Label>
              <Input id="category" placeholder="Ex: Vendas, Aluguel, Salários..." {...form.register("category")} data-testid="input-entry-category" />
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

      <AlertDialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover lançamento?</AlertDialogTitle>
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
