import { useState, useMemo, Fragment } from "react";
import {
  useListInvoices, getListInvoicesQueryKey,
  useCreateInvoice, useUpdateInvoice, useDeleteInvoice,
  useListClients, getListClientsQueryKey,
  useListCashFlow,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerFooter } from "@/components/ui/drawer";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useForm, useWatch } from "react-hook-form";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Plus, Trash2, CheckCircle2, AlertCircle, FileText,
  Banknote, Calculator, BadgeCheck, Pencil, ClipboardList,
  Clock, XCircle, CircleCheck, ChevronDown, ChevronRight, Search,
} from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { getGetDashboardSummaryQueryKey, getListCashFlowQueryKey } from "@workspace/api-client-react";

type InvoiceStatus = "pending" | "paid" | "overdue" | "requested" | "current";

interface InvoiceFormData {
  clientId: string;
  amount: string;
  dueDate: string;
  recurrence: string;
  status: InvoiceStatus;
  interestRate: string;
  lateFee: string;
  daysLate: string;
}

const STATUS_CONFIG: Record<InvoiceStatus, {
  label: string;
  icon: React.ElementType;
  classes: string;
}> = {
  pending:   { label: "Pendente",    icon: Clock,          classes: "bg-muted text-muted-foreground border border-border" },
  paid:      { label: "Pago",        icon: CircleCheck,    classes: "bg-emerald-500/10 text-emerald-500 border border-emerald-500/25" },
  overdue:   { label: "Vencido",     icon: XCircle,        classes: "bg-destructive/10 text-destructive border border-destructive/25" },
  requested: { label: "Solicitação", icon: FileText,       classes: "bg-primary/10 text-primary border border-primary/25" },
  current:   { label: "Em Dia",      icon: CheckCircle2,   classes: "bg-emerald-500/10 text-emerald-500 border border-emerald-500/25" },
};

const FILTER_TABS: { value: InvoiceStatus | "all"; label: string }[] = [
  { value: "all",       label: "Todas" },
  { value: "pending",   label: "Pendente" },
  { value: "paid",      label: "Pago" },
  { value: "overdue",   label: "Vencido" },
  { value: "requested", label: "Solicitação" },
  { value: "current",   label: "Em Dia" },
];

interface Breakdown {
  principal: number;
  interestAmount: number;
  lateFeeTotal: number;
  total: number;
}

function parseBRL(value: string): number {
  const cleaned = value.trim().replace(/\./g, "").replace(",", ".");
  return parseFloat(cleaned) || 0;
}

function calcBreakdown(amount: string, interestRate: string, lateFee: string, daysLate: string): Breakdown | null {
  const principal = parseBRL(amount);
  if (!principal || isNaN(principal)) return null;
  const rate = parseFloat(interestRate) || 0;
  const feePerDay = parseBRL(lateFee);
  const days = parseInt(daysLate) || 0;
  const interestAmount = (principal * rate) / 100;
  const lateFeeTotal = feePerDay * days;
  return { principal, interestAmount, lateFeeTotal, total: principal + interestAmount + lateFeeTotal };
}

interface EmprestimoSemanal {
  parcela: number;
  total: number;
  jurosTotal: number;
}

function calcularEmprestimoSemanal(valorTotal: number, numeroParcelas: number, taxa: number): EmprestimoSemanal {
  const base = valorTotal / numeroParcelas;
  const juros = valorTotal * taxa;
  const parcela = base + juros;
  const total = parcela * numeroParcelas;
  return { parcela, total, jurosTotal: juros * numeroParcelas };
}

export default function Invoices() {
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus | "all">("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [payInterestId, setPayInterestId] = useState<number | null>(null);
  const [quitacaoId, setQuitacaoId] = useState<number | null>(null);
  const [editingInvoice, setEditingInvoice] = useState<{
    id: number; clientId: number; clientName?: string | null; amount?: number | null;
    dueDate?: string | null; recurrence?: string | null; status: string;
    interestRate?: number | null; lateFee?: number | null; daysLate?: number | null;
  } | null>(null);

  const editForm = useForm<InvoiceFormData>({
    defaultValues: { clientId: "", amount: "", dueDate: "", recurrence: "none", status: "pending", interestRate: "0", lateFee: "0", daysLate: "0" },
  });

  const [loanTotal, setLoanTotal] = useState("");
  const [loanParcelas, setLoanParcelas] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");

  const toggleGroup = (clientId: number) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(clientId)) next.delete(clientId); else next.add(clientId);
      return next;
    });
  };

  const { data: invoices, isLoading } = useListInvoices(
    statusFilter !== "all" ? { status: statusFilter } : undefined,
    { query: { queryKey: getListInvoicesQueryKey(statusFilter !== "all" ? { status: statusFilter } : undefined) } }
  );

  const { data: clients } = useListClients(undefined, { query: { queryKey: getListClientsQueryKey() } });

  const createInvoice = useCreateInvoice();
  const updateInvoice = useUpdateInvoice();
  const deleteInvoice = useDeleteInvoice();

  const form = useForm<InvoiceFormData>({
    defaultValues: { clientId: "", amount: "", dueDate: "", recurrence: "none", status: "pending", interestRate: "0", lateFee: "0", daysLate: "0" },
  });

  const watchedAmount = useWatch({ control: form.control, name: "amount" });
  const watchedInterest = useWatch({ control: form.control, name: "interestRate" });
  const watchedLateFee = useWatch({ control: form.control, name: "lateFee" });
  const watchedDays = useWatch({ control: form.control, name: "daysLate" });
  const watchedRecurrence = useWatch({ control: form.control, name: "recurrence" });

  const breakdown = calcBreakdown(watchedAmount, watchedInterest, watchedLateFee, watchedDays);
  const hasEncargos = breakdown && (breakdown.interestAmount > 0 || breakdown.lateFeeTotal > 0);

  const loanCalc: EmprestimoSemanal | null = (() => {
    const P = parseBRL(loanTotal);
    const n = parseInt(loanParcelas) || 0;
    const r = (parseFloat(watchedInterest) || 0) / 100;
    if (P > 0 && n > 0 && r >= 0) return calcularEmprestimoSemanal(P, n, r);
    return null;
  })();

  const applyLoanCalc = () => {
    if (!loanCalc) return;
    form.setValue("amount", loanCalc.parcela.toFixed(2).replace(".", ","));
    const periodicidade = watchedRecurrence === "daily" ? "por dia" : watchedRecurrence === "weekly" ? "por semana" : "por quinzena";
    toast({ title: "Valor da parcela aplicado", description: `${formatCurrency(loanCalc.parcela)} ${periodicidade}` });
  };

  const invoiceFormFields = () => (
    <>
      <div>
        <Label>Recorrência</Label>
        <Select value={watchedRecurrence} onValueChange={(v) => form.setValue("recurrence", v)}>
          <SelectTrigger data-testid="select-invoice-recurrence">
            <SelectValue placeholder="Sem recorrência" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Sem recorrência</SelectItem>
            <SelectItem value="daily">Diário</SelectItem>
            <SelectItem value="weekly">Semanal</SelectItem>
            <SelectItem value="biweekly">Quinzenal</SelectItem>
            <SelectItem value="monthly">Mensal</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {(watchedRecurrence === "daily" || watchedRecurrence === "weekly" || watchedRecurrence === "biweekly") && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-amber-500">
            <Calculator className="h-4 w-4" />
            {watchedRecurrence === "daily" ? "Calculadora de Empréstimo Diário" : watchedRecurrence === "weekly" ? "Calculadora de Empréstimo Semanal" : "Calculadora de Empréstimo Quinzenal"}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Valor Total (R$)</Label>
              <Input placeholder="0,00" value={loanTotal} onChange={(e) => setLoanTotal(e.target.value)} data-testid="input-loan-total" />
            </div>
            <div>
              <Label className="text-xs">Nº de Parcelas</Label>
              <Input type="number" min="1" placeholder="ex: 10" value={loanParcelas} onChange={(e) => setLoanParcelas(e.target.value)} data-testid="input-loan-parcelas" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Taxa usada: <strong>{watchedInterest || "0"}%</strong> — defina no campo Juros (%) abaixo
          </p>
          {loanCalc && (
            <div className="rounded-md border border-border bg-background divide-y divide-border overflow-hidden text-sm">
              <div className="flex justify-between items-center px-3 py-2">
                <span className="text-muted-foreground">{watchedRecurrence === "daily" ? "Parcela diária" : watchedRecurrence === "weekly" ? "Parcela semanal" : "Parcela quinzenal"}</span>
                <span className="font-bold text-amber-500">{formatCurrency(loanCalc.parcela)}</span>
              </div>
              <div className="flex justify-between items-center px-3 py-2">
                <span className="text-muted-foreground">Juros total</span>
                <span className="font-medium">{formatCurrency(loanCalc.jurosTotal)}</span>
              </div>
              <div className="flex justify-between items-center px-3 py-2">
                <span className="text-muted-foreground">Total a receber</span>
                <span className="font-semibold">{formatCurrency(loanCalc.total)}</span>
              </div>
            </div>
          )}
          {loanCalc && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-full border-amber-500/50 text-amber-500 hover:bg-amber-500/10"
              onClick={applyLoanCalc}
              data-testid="button-apply-loan-calc"
            >
              Usar {formatCurrency(loanCalc.parcela)} como valor da parcela
            </Button>
          )}
        </div>
      )}

      <div>
        <Label>Cliente *</Label>
        <Select
          value={form.watch("clientId")}
          onValueChange={(v) => { form.setValue("clientId", v); form.clearErrors("clientId"); }}
        >
          <SelectTrigger data-testid="select-invoice-client" className={form.formState.errors.clientId ? "border-destructive" : ""}>
            <SelectValue placeholder="Selecione um cliente" />
          </SelectTrigger>
          <SelectContent className="max-h-60 overflow-y-auto">
            {clients?.map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {form.formState.errors.clientId && (
          <p className="text-xs text-destructive mt-1">{form.formState.errors.clientId.message}</p>
        )}
      </div>

      <div>
        <Label htmlFor="inv-amount">
          {(watchedRecurrence === "daily" || watchedRecurrence === "weekly" || watchedRecurrence === "biweekly") ? "Valor da Parcela (R$)" : "Valor Principal (R$)"}
        </Label>
        <Input id="inv-amount" placeholder="0,00" {...form.register("amount")} data-testid="input-invoice-amount" />
        {(watchedRecurrence === "daily" || watchedRecurrence === "weekly" || watchedRecurrence === "biweekly") && (
          <p className="text-xs text-muted-foreground mt-1">Use a calculadora acima para preencher automaticamente</p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="inv-interest">
            Juros (%)
            {watchedRecurrence === "daily" && <span className="ml-1 text-xs font-normal text-amber-500">= taxa diária</span>}
            {watchedRecurrence === "weekly" && <span className="ml-1 text-xs font-normal text-amber-500">= taxa semanal</span>}
            {watchedRecurrence === "biweekly" && <span className="ml-1 text-xs font-normal text-amber-500">= taxa quinzenal</span>}
          </Label>
          <Input id="inv-interest" type="number" min="0" step="0.01" placeholder="0" {...form.register("interestRate")} data-testid="input-invoice-interest" />
          <p className="text-xs text-muted-foreground mt-1">
            {watchedRecurrence === "daily" ? "taxa diária usada na calculadora" : watchedRecurrence === "weekly" ? "taxa semanal usada na calculadora" : watchedRecurrence === "biweekly" ? "taxa quinzenal usada na calculadora" : "% sobre o principal"}
          </p>
        </div>
        <div>
          <Label htmlFor="inv-latefee">Multa por dia (R$)</Label>
          <Input id="inv-latefee" placeholder="0,00" {...form.register("lateFee")} data-testid="input-invoice-latefee" />
          <p className="text-xs text-muted-foreground mt-1">valor fixo/dia de atraso</p>
        </div>
      </div>

      <div>
        <Label htmlFor="inv-days">Dias de Atraso</Label>
        <Input id="inv-days" type="number" min="0" step="1" placeholder="0" {...form.register("daysLate")} data-testid="input-invoice-days-late" />
      </div>

      {breakdown && breakdown.principal > 0 && (
        <div className="rounded-lg border border-border bg-muted/40 divide-y divide-border overflow-hidden">
          <div className="flex justify-between items-center px-4 py-2 text-sm">
            <span className="text-muted-foreground">Principal</span>
            <span className="font-medium tabular-nums">{formatCurrency(breakdown.principal)}</span>
          </div>
          {breakdown.interestAmount > 0 && (
            <div className="flex justify-between items-center px-4 py-2 text-sm">
              <span className="text-muted-foreground">Juros ({watchedInterest}% × {formatCurrency(breakdown.principal)})</span>
              <span className="font-medium text-amber-400 tabular-nums">+ {formatCurrency(breakdown.interestAmount)}</span>
            </div>
          )}
          {breakdown.lateFeeTotal > 0 && (
            <div className="flex justify-between items-center px-4 py-2 text-sm">
              <span className="text-muted-foreground">Multa ({watchedDays} dia(s) × {formatCurrency(parseFloat(watchedLateFee.replace(",", ".")) || 0)})</span>
              <span className="font-medium text-amber-400 tabular-nums">+ {formatCurrency(breakdown.lateFeeTotal)}</span>
            </div>
          )}
          <div className="flex justify-between items-center px-4 py-3 bg-muted/60">
            <span className="text-sm font-semibold">Total a pagar</span>
            <span className={`font-bold text-base tabular-nums ${hasEncargos ? "text-destructive" : "text-foreground"}`}>
              {formatCurrency(breakdown.total)}
            </span>
          </div>
        </div>
      )}

      <div>
        <Label htmlFor="inv-due">Data de Vencimento</Label>
        <Input id="inv-due" type="date" {...form.register("dueDate")} data-testid="input-invoice-due" />
      </div>

      <div>
        <Label>Status inicial</Label>
        <Select value={form.watch("status")} onValueChange={(v) => form.setValue("status", v as InvoiceStatus)}>
          <SelectTrigger data-testid="select-invoice-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pending">Pendente</SelectItem>
            <SelectItem value="paid">Pago</SelectItem>
            <SelectItem value="overdue">Vencido</SelectItem>
            <SelectItem value="requested">Solicitação</SelectItem>
            <SelectItem value="current">Em Dia</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </>
  );

  const onSubmit = (data: InvoiceFormData) => {
    const clientId = parseInt(data.clientId);
    if (!data.clientId || isNaN(clientId)) {
      form.setError("clientId", { message: "Selecione um cliente" });
      return;
    }
    createInvoice.mutate(
      {
        data: {
          clientId,
          amount: data.amount ? parseBRL(data.amount) : undefined,
          dueDate: data.dueDate || undefined,
          recurrence: (data.recurrence && data.recurrence !== "none" ? data.recurrence : undefined) as any,
          status: data.status,
          interestRate: parseFloat(data.interestRate) || 0,
          lateFee: parseBRL(data.lateFee) || 0,
          daysLate: parseInt(data.daysLate) || 0,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          setDialogOpen(false);
          form.reset();
          setLoanTotal(""); setLoanParcelas("");
          toast({ title: "Cobrança registrada" });
        },
        onError: (err: any) => {
          const msg = err?.response?.data?.error ?? "Erro ao criar cobrança. Tente novamente.";
          toast({ title: "Erro ao criar cobrança", description: msg, variant: "destructive" });
        },
      }
    );
  };

  const markAs = (id: number, status: InvoiceStatus) => {
    updateInvoice.mutate(
      { id, data: { status } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          toast({ title: `Cobrança marcada como ${STATUS_CONFIG[status].label.toLowerCase()}` });
        },
      }
    );
  };

  const confirmPayInterest = () => {
    if (payInterestId === null) return;
    updateInvoice.mutate(
      { id: payInterestId, data: { interestPaid: true } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListCashFlowQueryKey() });
          setPayInterestId(null);
          toast({ title: "Juros registrados como pagos", description: "Um lançamento foi criado no fluxo de caixa." });
        },
        onError: (err: any) => {
          const msg = err?.response?.data?.error ?? "Erro ao registrar pagamento de juros.";
          toast({ title: "Erro", description: msg, variant: "destructive" });
        },
      }
    );
  };

  const confirmQuitacao = () => {
    if (quitacaoId === null) return;
    updateInvoice.mutate(
      { id: quitacaoId, data: { status: "paid" } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListCashFlowQueryKey() });
          setQuitacaoId(null);
          toast({ title: "Quitação registrada", description: "Cobrança marcada como paga." });
        },
        onError: (err: any) => {
          const msg = err?.response?.data?.error ?? "Erro ao registrar quitação.";
          toast({ title: "Erro", description: msg, variant: "destructive" });
        },
      }
    );
  };

  const openEditDialog = (inv: NonNullable<typeof editingInvoice>) => {
    setEditingInvoice(inv);
    editForm.reset({
      clientId: String(inv.clientId),
      amount: inv.amount != null ? String(inv.amount).replace(".", ",") : "",
      dueDate: inv.dueDate ? inv.dueDate.slice(0, 10) : "",
      recurrence: inv.recurrence ?? "none",
      status: inv.status as InvoiceStatus,
      interestRate: inv.interestRate != null ? String(inv.interestRate) : "0",
      lateFee: inv.lateFee != null ? String(inv.lateFee).replace(".", ",") : "0",
      daysLate: inv.daysLate != null ? String(inv.daysLate) : "0",
    });
  };

  const onEditSubmit = (data: InvoiceFormData) => {
    if (!editingInvoice) return;
    updateInvoice.mutate(
      {
        id: editingInvoice.id,
        data: {
          amount: data.amount ? parseBRL(data.amount) : undefined,
          dueDate: data.dueDate || undefined,
          status: data.status as InvoiceStatus,
          interestRate: parseFloat(data.interestRate) || 0,
          lateFee: parseBRL(data.lateFee) || 0,
          daysLate: parseInt(data.daysLate) || 0,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          setEditingInvoice(null);
          toast({ title: "Cobrança atualizada" });
        },
        onError: (err: any) => {
          const msg = err?.response?.data?.error ?? "Erro ao atualizar cobrança. Tente novamente.";
          toast({ title: "Erro ao atualizar cobrança", description: msg, variant: "destructive" });
        },
      }
    );
  };

  const confirmDelete = () => {
    if (deleteId === null) return;
    deleteInvoice.mutate(
      { id: deleteId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          setDeleteId(null);
          toast({ title: "Cobrança removida" });
        },
      }
    );
  };

  const payInterestInvoice = payInterestId !== null ? invoices?.find((i) => i.id === payInterestId) : null;
  const payInterestAmount = payInterestInvoice
    ? ((payInterestInvoice.amount ?? 0) * (payInterestInvoice.interestRate ?? 0)) / 100
      + (payInterestInvoice.lateFee ?? 0) * (payInterestInvoice.daysLate ?? 0)
    : 0;

  const quitacaoInvoice = quitacaoId !== null ? invoices?.find((i) => i.id === quitacaoId) : null;
  const quitacaoTotal = quitacaoInvoice
    ? (quitacaoInvoice.amount ?? 0)
      + ((quitacaoInvoice.amount ?? 0) * (quitacaoInvoice.interestRate ?? 0)) / 100
      + (quitacaoInvoice.lateFee ?? 0) * (quitacaoInvoice.daysLate ?? 0)
    : 0;

  // KPI counts — always from full unfiltered data
  const { data: allInvoices } = useListInvoices(undefined, { query: { queryKey: getListInvoicesQueryKey() } });
  const totalCount   = allInvoices?.length ?? 0;
  const overdueCount = allInvoices?.filter((i) => i.status === "overdue").length ?? 0;
  const pendingCount = allInvoices?.filter((i) => i.status === "pending" || i.status === "requested").length ?? 0;

  // Pagas (juros) = clientes distintos que pagaram juros este mês via cashflow
  const { data: jurosEntries } = useListCashFlow({ type: "income", category: "juros" });
  const nowInv = new Date();
  const thisMonthInv = nowInv.getMonth();
  const thisYearInv = nowInv.getFullYear();
  const invoiceClientMap = new Map((allInvoices ?? []).map((inv) => [inv.id, inv.clientId]));
  const jurosThisMonth = (jurosEntries ?? []).filter((e) => {
    if (!e.date) return true;
    const d = new Date(e.date);
    return d.getMonth() === thisMonthInv && d.getFullYear() === thisYearInv;
  });
  const clientsWhoPayedJuros = new Set(
    jurosThisMonth
      .map((e) => {
        const match = e.description?.match(/#(\d+)$/);
        if (!match) return null;
        return invoiceClientMap.get(Number(match[1]));
      })
      .filter((id): id is number => id != null)
  );
  const paidJurosCount = clientsWhoPayedJuros.size;

  // Mapa clientId → total de parcelas de juros pagas (todos os tempos)
  const clientParcelasMap = new Map<number, number>();
  (jurosEntries ?? []).forEach((e) => {
    const match = e.description?.match(/#(\d+)$/);
    if (!match) return;
    const clientId = invoiceClientMap.get(Number(match[1]));
    if (clientId == null) return;
    clientParcelasMap.set(clientId, (clientParcelasMap.get(clientId) ?? 0) + 1);
  });

  const RECURRENCE_LABEL: Record<string, string> = { daily: "Diário", weekly: "Semanal", biweekly: "Quinzenal", monthly: "Mensal" };

  // Group invoices by clientId — preserving order of first appearance
  const groupedRows = useMemo(() => {
    if (!invoices) return [];
    const map = new Map<number, typeof invoices>();
    const order: number[] = [];
    for (const inv of invoices) {
      const cid = inv.clientId;
      if (!map.has(cid)) { map.set(cid, []); order.push(cid); }
      map.get(cid)!.push(inv);
    }
    const all = order.map((cid) => ({ clientId: cid, invoices: map.get(cid)! }));
    if (!search.trim()) return all;
    const q = search.trim().toLowerCase();
    return all.filter(({ invoices: grp }) =>
      (grp[0].clientName ?? "").toLowerCase().includes(q)
    );
  }, [invoices, search]);

  return (
    <AppLayout>
      {/* HEADER */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-7">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-7 h-7 rounded-lg bg-amber-500/15 border border-amber-500/25 flex items-center justify-center">
              <ClipboardList className="h-3.5 w-3.5 text-amber-500" />
            </div>
            <h1 className="text-2xl font-bold">Cobranças</h1>
          </div>
          <p className="text-muted-foreground text-sm">
            Contratos ativos, parcelas, juros e quitações
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)} data-testid="button-add-invoice" className="gap-2">
          <Plus className="h-4 w-4" />
          Nova Cobrança
        </Button>
      </div>

      {/* KPI CARDS */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-7">
        <Card className="border-border/60">
          <div className="p-4 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
              <ClipboardList className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total</p>
              <p className="text-xl font-bold tabular-nums">{isLoading ? "—" : totalCount}</p>
            </div>
          </div>
        </Card>
        <Card className={overdueCount > 0 ? "border-destructive/20 bg-destructive/5" : "border-border/60"}>
          <div className="p-4 flex items-center gap-3">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${overdueCount > 0 ? "bg-destructive/15" : "bg-muted"}`}>
              <XCircle className={`h-4 w-4 ${overdueCount > 0 ? "text-destructive" : "text-muted-foreground"}`} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Vencidas</p>
              <p className={`text-xl font-bold tabular-nums ${overdueCount > 0 ? "text-destructive" : ""}`}>{overdueCount}</p>
            </div>
          </div>
        </Card>
        <Card className="border-border/60">
          <div className="p-4 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
              <Clock className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">A receber</p>
              <p className="text-xl font-bold tabular-nums">{pendingCount}</p>
            </div>
          </div>
        </Card>
        <Card className="border-emerald-500/20 bg-emerald-500/5">
          <div className="p-4 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/15 flex items-center justify-center shrink-0">
              <CircleCheck className="h-4 w-4 text-emerald-500" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Pagaram juros</p>
              <p className="text-xl font-bold tabular-nums text-emerald-500">{paidJurosCount}</p>
              <p className="text-[10px] text-muted-foreground/60 leading-tight">clientes este mês</p>
            </div>
          </div>
        </Card>
      </div>

      {/* FILTROS + BUSCA */}
      <div className="flex flex-col gap-3 mb-5">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Buscar devedor pelo nome..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            data-testid="input-search-invoice"
          />
        </div>
        <div className="flex flex-wrap gap-2">
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
      </div>

      {/* TABELA */}
      {isLoading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      ) : !invoices || invoices.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16 text-center">
            <ClipboardList className="h-10 w-10 text-muted-foreground mb-3 opacity-40" />
            <p className="font-medium text-muted-foreground">Nenhuma cobrança encontrada</p>
            <p className="text-sm text-muted-foreground/70 mt-1">Registre contratos e parcelas de empréstimos</p>
            <Button variant="outline" className="mt-5" onClick={() => setDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Criar primeira cobrança
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full min-w-[700px]">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground bg-muted/30">
                  <th className="px-5 py-3 font-medium">Cliente</th>
                  <th className="px-5 py-3 font-medium">Principal</th>
                  <th className="px-5 py-3 font-medium">Total a Pagar</th>
                  <th className="px-5 py-3 font-medium">Vencimento</th>
                  <th className="px-5 py-3 font-medium">Recorrência</th>
                  <th className="px-5 py-3 font-medium text-center">Parcelas Pagas</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {groupedRows.map(({ clientId, invoices: group }) => {
                  const isMulti = group.length > 1;
                  const isExpanded = expandedGroups.has(clientId);
                  const clientName = group[0].clientName ?? `Cliente #${clientId}`;

                  const renderInvRow = (inv: typeof group[0], isChild: boolean) => {
                    const isOverdue = inv.status === "overdue";
                    const isPaid = inv.status === "paid";
                    const hasInterest = (inv.interestRate ?? 0) > 0;
                    const hasCharges = hasInterest || (inv.lateFee ?? 0) > 0;
                    const isOverdueWithFees = isOverdue && hasCharges;
                    const interestAmt = inv.amount && inv.interestRate ? (inv.amount * inv.interestRate) / 100 : 0;
                    const lateFeeTotal = (inv.lateFee ?? 0) * (inv.daysLate ?? 0);
                    const alreadyPaidInterest = inv.interestPaid === true;
                    const cfg = STATUS_CONFIG[inv.status as InvoiceStatus];
                    const StatusIcon = cfg?.icon ?? FileText;

                    return (
                      <tr
                        key={inv.id}
                        className={`border-b border-border last:border-0 hover:bg-accent/40 transition-colors group ${isChild ? "bg-muted/10" : ""}`}
                        data-testid={`row-invoice-${inv.id}`}
                      >
                        <td className="px-5 py-3.5 font-medium text-sm">
                          {isChild ? (
                            <span className="pl-5 text-muted-foreground text-xs flex items-center gap-1.5">
                              <span className="w-1.5 h-1.5 rounded-full bg-border inline-block" />
                              Contrato #{inv.id}
                            </span>
                          ) : (
                            inv.clientName ?? `Cliente #${inv.clientId}`
                          )}
                        </td>
                        <td className="px-5 py-3.5 font-semibold text-sm tabular-nums">
                          {formatCurrency(inv.amount)}
                        </td>
                        <td className="px-5 py-3.5 text-sm">
                          {isOverdueWithFees ? (
                            alreadyPaidInterest ? (
                              <div>
                                <span className="font-semibold tabular-nums">{formatCurrency(inv.amount)}</span>
                                <div className="mt-1">
                                  <span className="text-xs text-emerald-500 bg-emerald-500/10 border border-emerald-500/25 rounded px-1.5 py-0.5">
                                    Juros pagos
                                  </span>
                                </div>
                              </div>
                            ) : (
                              <div>
                                <span className="font-bold text-destructive tabular-nums">{formatCurrency(inv.totalDue)}</span>
                                <div className="text-xs text-muted-foreground mt-0.5 space-y-0.5">
                                  {(inv.interestRate ?? 0) > 0 && (
                                    <div>Juros {inv.interestRate}%/mês = {formatCurrency(interestAmt)}</div>
                                  )}
                                  {(inv.lateFee ?? 0) > 0 && (inv.daysLate ?? 0) > 0 && (
                                    <div>Multa {inv.daysLate}d × {formatCurrency(inv.lateFee)} = {formatCurrency(lateFeeTotal)}</div>
                                  )}
                                </div>
                              </div>
                            )
                          ) : (
                            <div>
                              <span className="text-muted-foreground font-medium tabular-nums">{formatCurrency(inv.amount)}</span>
                              {hasInterest && !isPaid && (
                                <div className="text-xs text-amber-500 mt-0.5">
                                  Juros {inv.interestRate}%/mês = {formatCurrency(interestAmt)}
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="px-5 py-3.5 text-sm text-muted-foreground whitespace-nowrap">
                          {formatDate(inv.dueDate)}
                        </td>
                        <td className="px-5 py-3.5 text-sm text-muted-foreground">
                          {inv.recurrence ? (RECURRENCE_LABEL[inv.recurrence] ?? "-") : <span className="opacity-40">—</span>}
                        </td>
                        <td className="px-5 py-3.5 text-center">
                          {(() => {
                            const count = clientParcelasMap.get(inv.clientId) ?? 0;
                            return count > 0 ? (
                              <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-xs font-bold text-emerald-500">
                                {count}
                              </span>
                            ) : (
                              <span className="text-muted-foreground/40 text-xs">—</span>
                            );
                          })()}
                        </td>
                        <td className="px-5 py-3.5" data-testid={`status-invoice-${inv.id}`}>
                          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold ${cfg?.classes ?? "bg-muted text-muted-foreground border border-border"}`}>
                            <StatusIcon className="h-3 w-3" />
                            {cfg?.label ?? inv.status}
                          </span>
                        </td>
                        <td className="px-5 py-3.5">
                          <div className="flex items-center justify-end gap-1 flex-wrap">
                            {hasInterest && !isPaid && !alreadyPaidInterest && (
                              <Button
                                variant="ghost"
                                size="sm"
                                title="Pagar somente os juros do mês"
                                onClick={() => setPayInterestId(inv.id)}
                                data-testid={`button-pay-interest-${inv.id}`}
                                className="h-7 text-amber-500 hover:text-amber-600 hover:bg-amber-500/10 text-xs gap-1 px-2"
                              >
                                <Banknote className="h-3.5 w-3.5" />
                                Pagar Juros
                              </Button>
                            )}
                            {!isPaid && (
                              <Button
                                variant="ghost"
                                size="sm"
                                title="Registrar quitação (pagamento total)"
                                onClick={() => setQuitacaoId(inv.id)}
                                data-testid={`button-quitacao-${inv.id}`}
                                className="h-7 text-emerald-500 hover:text-emerald-600 hover:bg-emerald-500/10 text-xs gap-1 px-2"
                              >
                                <BadgeCheck className="h-3.5 w-3.5" />
                                Quitação
                              </Button>
                            )}
                            {inv.status === "pending" && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                title="Marcar como vencido"
                                onClick={() => markAs(inv.id, "overdue")}
                                data-testid={`button-overdue-invoice-${inv.id}`}
                              >
                                <AlertCircle className="h-3.5 w-3.5 text-destructive" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                              title="Editar cobrança"
                              onClick={() => openEditDialog(inv as any)}
                              data-testid={`button-edit-invoice-${inv.id}`}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                              onClick={() => setDeleteId(inv.id)}
                              data-testid={`button-delete-invoice-${inv.id}`}
                            >
                              <Trash2 className="h-3.5 w-3.5 text-destructive" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  };

                  if (!isMulti) return renderInvRow(group[0], false);

                  // Multi-contract group header
                  const totalPrincipal = group.reduce((s, inv) => s + (inv.amount ?? 0), 0);
                  const hasOverdue = group.some((inv) => inv.status === "overdue");
                  const recurrences = [...new Set(group.map((inv) => inv.recurrence).filter(Boolean))];

                  return (
                    <Fragment key={`group-${clientId}`}>
                      <tr
                        onClick={() => toggleGroup(clientId)}
                        className="cursor-pointer border-b border-border hover:bg-accent/60 transition-colors bg-muted/25"
                      >
                        <td className="px-5 py-3.5" colSpan={8}>
                          <div className="flex items-center gap-2 flex-wrap">
                            {isExpanded
                              ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                              : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                            }
                            <span className="font-semibold text-sm">{clientName}</span>
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-primary/10 border border-primary/20 text-xs font-medium text-primary">
                              {group.length} contratos
                            </span>
                            {hasOverdue && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-destructive/10 border border-destructive/20 text-xs font-medium text-destructive">
                                Em atraso
                              </span>
                            )}
                            {recurrences.map((r) => r && (
                              <span key={r} className="inline-flex items-center px-2 py-0.5 rounded-full bg-muted border border-border text-xs text-muted-foreground">
                                {RECURRENCE_LABEL[r] ?? r}
                              </span>
                            ))}
                            <span className="ml-auto text-sm font-bold tabular-nums">
                              {formatCurrency(totalPrincipal)}
                            </span>
                          </div>
                        </td>
                      </tr>
                      {isExpanded && group.map((inv) => renderInvRow(inv, true))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* NOVA COBRANÇA — Drawer no mobile, Dialog no desktop */}
      {isMobile ? (
        <Drawer open={dialogOpen} shouldScaleBackground={false} onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) { form.reset(); setLoanTotal(""); setLoanParcelas(""); }
        }}>
          <DrawerContent className="max-h-[92dvh] flex flex-col">
            <DrawerHeader className="text-left pb-2">
              <DrawerTitle>Nova Cobrança</DrawerTitle>
            </DrawerHeader>
            <div className="flex-1 overflow-y-auto px-4 pb-2">
              <form id="nova-cobranca-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                {invoiceFormFields()}
              </form>
            </div>
            <DrawerFooter className="pt-2">
              <Button form="nova-cobranca-form" type="submit" disabled={createInvoice.isPending} data-testid="button-submit-invoice">Registrar</Button>
              <Button type="button" variant="outline" onClick={() => { setDialogOpen(false); form.reset(); }}>Cancelar</Button>
            </DrawerFooter>
          </DrawerContent>
        </Drawer>
      ) : (
        <Dialog open={dialogOpen} onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) { form.reset(); setLoanTotal(""); setLoanParcelas(""); }
        }}>
          <DialogContent className="max-h-[90dvh] overflow-y-auto overscroll-contain sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Nova Cobrança</DialogTitle>
            </DialogHeader>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              {invoiceFormFields()}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => { setDialogOpen(false); form.reset(); }}>Cancelar</Button>
                <Button type="submit" disabled={createInvoice.isPending} data-testid="button-submit-invoice">Registrar</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}

      {/* Pagar juros */}
      <AlertDialog open={payInterestId !== null} onOpenChange={(o) => !o && setPayInterestId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Pagar somente os juros?</AlertDialogTitle>
            <AlertDialogDescription>
              O cliente está pagando apenas os juros e multa
              {payInterestAmount > 0 && <> no valor de <strong>{formatCurrency(payInterestAmount)}</strong></>}.
              {" "}O principal de <strong>{formatCurrency(payInterestInvoice?.amount)}</strong> permanecerá em aberto.
              {" "}Um lançamento será criado no fluxo de caixa.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={confirmPayInterest}>Confirmar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Quitação */}
      <AlertDialog open={quitacaoId !== null} onOpenChange={(o) => !o && setQuitacaoId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Registrar quitação?</AlertDialogTitle>
            <AlertDialogDescription>
              O cliente está quitando a dívida completa
              {quitacaoTotal > 0 && <> no valor total de <strong>{formatCurrency(quitacaoTotal)}</strong></>}
              {quitacaoInvoice?.interestRate
                ? <>, incluindo juros de {quitacaoInvoice.interestRate}%/mês ({formatCurrency(((quitacaoInvoice.amount ?? 0) * (quitacaoInvoice.interestRate ?? 0)) / 100)})</>
                : null
              }. A cobrança será marcada como <strong>Paga</strong>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={confirmQuitacao}>Confirmar Quitação</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Editar cobrança */}
      <Dialog open={editingInvoice !== null} onOpenChange={(open) => { if (!open) setEditingInvoice(null); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Editar Cobrança</DialogTitle>
          </DialogHeader>
          <form onSubmit={editForm.handleSubmit(onEditSubmit)} className="space-y-4">
            <div>
              <Label>Cliente *</Label>
              <Select value={editForm.watch("clientId")} onValueChange={(v) => { editForm.setValue("clientId", v); editForm.clearErrors("clientId"); }}>
                <SelectTrigger data-testid="select-edit-invoice-client">
                  <SelectValue placeholder="Selecione um cliente" />
                </SelectTrigger>
                <SelectContent className="max-h-60 overflow-y-auto">
                  {clients?.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="edit-inv-amount">Valor Principal (R$)</Label>
              <Input id="edit-inv-amount" placeholder="0,00" {...editForm.register("amount")} data-testid="input-edit-invoice-amount" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="edit-inv-interest">Juros (%)</Label>
                <Input id="edit-inv-interest" type="number" min="0" step="0.01" placeholder="0" {...editForm.register("interestRate")} data-testid="input-edit-invoice-interest" />
              </div>
              <div>
                <Label htmlFor="edit-inv-latefee">Multa por dia (R$)</Label>
                <Input id="edit-inv-latefee" placeholder="0,00" {...editForm.register("lateFee")} data-testid="input-edit-invoice-latefee" />
              </div>
            </div>
            <div>
              <Label htmlFor="edit-inv-days">Dias de Atraso</Label>
              <Input id="edit-inv-days" type="number" min="0" step="1" placeholder="0" {...editForm.register("daysLate")} data-testid="input-edit-invoice-days-late" />
            </div>
            <div>
              <Label htmlFor="edit-inv-due">Data de Vencimento</Label>
              <Input id="edit-inv-due" type="date" {...editForm.register("dueDate")} data-testid="input-edit-invoice-due" />
            </div>
            <div>
              <Label>Recorrência</Label>
              <Select value={editForm.watch("recurrence")} onValueChange={(v) => editForm.setValue("recurrence", v)}>
                <SelectTrigger data-testid="select-edit-invoice-recurrence">
                  <SelectValue placeholder="Sem recorrência" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sem recorrência</SelectItem>
                  <SelectItem value="daily">Diário</SelectItem>
                  <SelectItem value="weekly">Semanal</SelectItem>
                  <SelectItem value="biweekly">Quinzenal</SelectItem>
                  <SelectItem value="monthly">Mensal</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Status</Label>
              <Select value={editForm.watch("status")} onValueChange={(v) => editForm.setValue("status", v as InvoiceStatus)}>
                <SelectTrigger data-testid="select-edit-invoice-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">Pendente</SelectItem>
                  <SelectItem value="paid">Pago</SelectItem>
                  <SelectItem value="overdue">Vencido</SelectItem>
                  <SelectItem value="requested">Solicitação</SelectItem>
                  <SelectItem value="current">Em Dia</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditingInvoice(null)}>Cancelar</Button>
              <Button type="submit" disabled={updateInvoice.isPending} data-testid="button-submit-edit-invoice">Salvar</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Excluir */}
      <AlertDialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover cobrança?</AlertDialogTitle>
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
