import {
  useGetDashboardSummary,
  getGetDashboardSummaryQueryKey,
  useGetDashboardCashflowDaily,
  getGetDashboardCashflowDailyQueryKey,
  useListInvoices,
  getListInvoicesQueryKey,
  useListClients,
  getListClientsQueryKey,
  useListCashFlow,
} from "@workspace/api-client-react";
import type { Invoice, Client } from "@workspace/api-client-react";
import { useUser } from "@clerk/react";
import { useLocation } from "wouter";
import { formatCurrency } from "@/lib/format";
import { AppLayout } from "@/components/layout/app-layout";
import {
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import {
  TrendingUp,
  Wallet,
  AlertTriangle,
  DollarSign,
  Plus,
  MessageCircle,
  FileText,
  RefreshCw,
  ChevronRight,
  ArrowUpRight,
  Zap,
} from "lucide-react";

type InvoiceStatus = "pending" | "paid" | "overdue" | "requested" | "current";

function getStatusConfig(status: InvoiceStatus) {
  const map: Record<InvoiceStatus, { label: string; cls: string }> = {
    current: { label: "Em dia", cls: "bg-green-500/20 text-green-400 border border-green-500/30" },
    pending: { label: "Pendente", cls: "bg-amber-500/20 text-amber-400 border border-amber-500/30" },
    requested: { label: "Solicitação", cls: "bg-blue-500/20 text-blue-400 border border-blue-500/30" },
    overdue: { label: "Vencido", cls: "bg-red-500/20 text-red-400 border border-red-500/30" },
    paid: { label: "Pago", cls: "bg-white/10 text-white/40 border border-white/10" },
  };
  return map[status] ?? map.pending;
}

function getInitials(name: string) {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export default function Dashboard() {
  const { user } = useUser();
  const [, navigate] = useLocation();

  const firstName = user?.firstName ?? user?.fullName?.split(" ")[0] ?? "você";

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";

  const { data: summary, isLoading: summaryLoading } = useGetDashboardSummary({
    query: { queryKey: getGetDashboardSummaryQueryKey() },
  });

  const { data: dailyData } = useGetDashboardCashflowDaily({
    query: { queryKey: getGetDashboardCashflowDailyQueryKey() },
  });

  const { data: invoicesRaw } = useListInvoices(undefined, {
    query: { queryKey: getListInvoicesQueryKey() },
  });

  const { data: clientsRaw } = useListClients(undefined, {
    query: { queryKey: getListClientsQueryKey() },
  });

  const clientPhoneMap = new Map<number, string>(
    (clientsRaw ?? []).map((c: Client) => [c.id, c.phone ?? ""])
  );

  const pendingInvoices = (invoicesRaw ?? [])
    .filter((inv: Invoice) => inv.status !== "paid")
    .sort((a: Invoice, b: Invoice) => {
      const order: Record<string, number> = { overdue: 0, pending: 1, requested: 2, current: 3 };
      return (order[a.status] ?? 9) - (order[b.status] ?? 9);
    })
    .slice(0, 8);

  // Saldo Líquido = soma das entradas de juros recebidos (cashflow income, category=juros) no mês atual
  const { data: jurosEntries } = useListCashFlow({ type: "income", category: "juros" });
  const nowDash = new Date();
  const thisMonthDash = nowDash.getMonth();
  const thisYearDash = nowDash.getFullYear();
  const jurosPagosMes = (jurosEntries ?? [])
    .filter((entry) => {
      if (!entry.date) return true;
      const d = new Date(entry.date);
      return d.getMonth() === thisMonthDash && d.getFullYear() === thisYearDash;
    })
    .reduce((sum: number, entry) => sum + Number(entry.amount ?? 0), 0);

  const formattedDaily = (dailyData ?? []).map((d) => ({
    ...d,
    dateLabel: new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
    }).format(new Date(d.date + "T00:00:00")),
  }));

  const carteiraData = summary
    ? [
        { name: "Pendentes", value: summary.pendingInvoicesTotal, color: "#06b6d4" },
        { name: "Inadimplente", value: summary.overdueDebtsTotal, color: "#ef4444" },
        { name: "Recebido", value: summary.totalIncome, color: "#22c55e" },
      ].filter((d) => d.value > 0)
    : [];

  const totalCarteira = carteiraData.reduce((s, d) => s + d.value, 0);

  const kpiSkeleton = (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="bg-white/5 border border-white/10 rounded-2xl p-5 animate-pulse h-32" />
      ))}
    </div>
  );

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* GREETING BANNER */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-foreground">
              {greeting}, {firstName} 👋
            </h1>
            <p className="text-muted-foreground text-sm capitalize mt-0.5">
              {new Date().toLocaleDateString("pt-BR", {
                weekday: "long",
                day: "numeric",
                month: "long",
              })}
            </p>
          </div>
          {summary && (
            <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm text-muted-foreground w-fit">
              <span className="w-2 h-2 rounded-full bg-green-400" />
              Carteira com{" "}
              <strong className="text-foreground ml-1">{summary.activeClients} clientes ativos</strong>
            </div>
          )}
        </div>

        {/* KPIs */}
        {summaryLoading || !summary ? (
          kpiSkeleton
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Caixa de Hoje */}
            <div className="bg-gradient-to-br from-green-950/40 to-background border border-green-500/20 rounded-2xl p-5 hover:border-green-500/40 transition-all group">
              <div className="flex items-start justify-between mb-4">
                <div className="w-10 h-10 rounded-xl bg-green-500/10 flex items-center justify-center group-hover:bg-green-500/20 transition-all">
                  <Wallet className="w-5 h-5 text-green-400" />
                </div>
                <span className="flex items-center gap-1 text-xs text-green-400 bg-green-500/10 px-2 py-1 rounded-full">
                  <ArrowUpRight className="w-3 h-3" /> hoje
                </span>
              </div>
              <p className="text-muted-foreground text-xs mb-1">Emprestado Hoje</p>
              <p className="text-xl md:text-2xl font-bold text-foreground">
                {formatCurrency(summary.todayLoaned)}
              </p>
              <p className="text-xs text-muted-foreground/60 mt-1">principal das cobranças de hoje</p>
            </div>

            {/* Carteira Ativa */}
            <div className="bg-gradient-to-br from-cyan-950/40 to-background border border-cyan-500/20 rounded-2xl p-5 hover:border-cyan-500/40 transition-all group">
              <div className="flex items-start justify-between mb-4">
                <div className="w-10 h-10 rounded-xl bg-cyan-500/10 flex items-center justify-center group-hover:bg-cyan-500/20 transition-all">
                  <DollarSign className="w-5 h-5 text-cyan-400" />
                </div>
                <span className="text-xs text-cyan-400 bg-cyan-500/10 px-2 py-1 rounded-full">
                  {summary.pendingInvoicesCount} cobranças
                </span>
              </div>
              <p className="text-muted-foreground text-xs mb-1">Carteira Ativa</p>
              <p className="text-xl md:text-2xl font-bold text-foreground">
                {formatCurrency(summary.totalLoaned)}
              </p>
              <p className="text-xs text-muted-foreground/60 mt-1">total emprestado em aberto</p>
            </div>

            {/* Inadimplência */}
            <div className="relative bg-gradient-to-br from-red-950/40 to-background border border-red-500/30 rounded-2xl p-5 hover:border-red-500/50 transition-all group">
              <div className="flex items-start justify-between mb-4">
                <div className="w-10 h-10 rounded-xl bg-red-500/15 flex items-center justify-center group-hover:bg-red-500/25 transition-all">
                  <AlertTriangle className="w-5 h-5 text-red-400" />
                </div>
                {summary.overdueDebtsCount > 0 && (
                  <span className="text-xs font-bold text-red-300 bg-red-900/50 border border-red-500/30 px-2 py-1 rounded-full">
                    {summary.overdueDebtsCount} dívida(s)
                  </span>
                )}
              </div>
              <p className="text-muted-foreground text-xs mb-1">Inadimplência</p>
              <p className="text-xl md:text-2xl font-bold text-red-300">
                {formatCurrency(summary.overdueDebtsTotal)}
              </p>
              <p className="text-xs text-red-400/60 mt-1">dívidas vencidas e não pagas</p>
            </div>

            {/* Saldo Líquido */}
            <div className="bg-gradient-to-br from-emerald-950/40 to-background border border-emerald-500/20 rounded-2xl p-5 hover:border-emerald-500/40 transition-all group">
              <div className="flex items-start justify-between mb-4">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center group-hover:bg-emerald-500/20 transition-all">
                  <TrendingUp className="w-5 h-5 text-emerald-400" />
                </div>
                <span className="flex items-center gap-1 text-xs text-emerald-400 bg-emerald-500/10 px-2 py-1 rounded-full">
                  saldo
                </span>
              </div>
              <p className="text-muted-foreground text-xs mb-1">Saldo Líquido</p>
              <p className="text-xl md:text-2xl font-bold text-emerald-400">
                {formatCurrency(jurosPagosMes)}
              </p>
              <p className="text-xs text-muted-foreground/60 mt-1">juros recebidos este mês</p>
            </div>
          </div>
        )}

        {/* QUICK ACTIONS */}
        <div>
          <p className="text-xs text-muted-foreground font-semibold uppercase tracking-widest mb-3">
            Ações Rápidas
          </p>
          <div className="flex flex-wrap gap-2">
            {[
              {
                label: "Nova Cobrança",
                icon: <Plus className="w-3.5 h-3.5" />,
                color: "text-green-400 bg-green-500/10 border-green-500/20 hover:bg-green-500/20",
                action: () => navigate("/invoices"),
              },
              {
                label: "Cobrar Cliente",
                icon: <Zap className="w-3.5 h-3.5" />,
                color: "text-amber-400 bg-amber-500/10 border-amber-500/20 hover:bg-amber-500/20",
                action: () => navigate("/invoices"),
              },
              {
                label: "Ver Dívidas",
                icon: <RefreshCw className="w-3.5 h-3.5" />,
                color: "text-red-400 bg-red-500/10 border-red-500/20 hover:bg-red-500/20",
                action: () => navigate("/debts"),
              },
              {
                label: "Novo Cliente",
                icon: <Plus className="w-3.5 h-3.5" />,
                color: "text-purple-400 bg-purple-500/10 border-purple-500/20 hover:bg-purple-500/20",
                action: () => navigate("/clients"),
              },
              {
                label: "Ver Cobranças",
                icon: <FileText className="w-3.5 h-3.5" />,
                color: "text-blue-400 bg-blue-500/10 border-blue-500/20 hover:bg-blue-500/20",
                action: () => navigate("/invoices"),
              },
            ].map((a) => (
              <button
                key={a.label}
                onClick={a.action}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border text-xs font-medium transition-all ${a.color}`}
              >
                {a.icon} {a.label}
              </button>
            ))}
          </div>
        </div>

        {/* COBRANÇAS PENDENTES TABLE */}
        <div className="bg-card border border-border rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-border flex items-center justify-between">
            <div>
              <p className="text-foreground font-semibold text-sm">Cobranças Pendentes</p>
              <p className="text-muted-foreground text-xs mt-0.5">
                {pendingInvoices.length} registro(s) · ordenado por urgência
              </p>
            </div>
            <button
              onClick={() => navigate("/invoices")}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-all"
            >
              Ver todas <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {pendingInvoices.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
              Nenhuma cobrança pendente 🎉
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    {["Cliente", "Valor", "Vencimento", "Dias Atraso", "Status", "Ações"].map((h) => (
                      <th
                        key={h}
                        className="px-4 py-3 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pendingInvoices.map((inv: Invoice) => {
                    const name = inv.clientName ?? `Cliente #${inv.clientId}`;
                    const phone = clientPhoneMap.get(inv.clientId) ?? "";
                    const status = inv.status as InvoiceStatus;
                    const sc = getStatusConfig(status);
                    const dueLabel = inv.dueDate
                      ? new Intl.DateTimeFormat("pt-BR").format(
                          new Date(inv.dueDate + "T00:00:00")
                        )
                      : "—";
                    const waUrl = phone
                      ? `https://wa.me/${phone.replace(/\D/g, "")}?text=${encodeURIComponent(`Olá ${name}, sua cobrança de ${formatCurrency(inv.amount ?? 0)} está pendente.`)}`
                      : null;

                    return (
                      <tr
                        key={inv.id}
                        className={`border-b border-border/50 hover:bg-muted/30 transition-all ${status === "overdue" ? "bg-red-500/5" : ""}`}
                      >
                        <td className="px-4 py-3.5">
                          <div className="flex items-center gap-2.5">
                            <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold text-muted-foreground shrink-0">
                              {getInitials(name)}
                            </div>
                            <span className="text-sm text-foreground font-medium truncate max-w-[120px]">
                              {name}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3.5 text-sm font-semibold text-foreground whitespace-nowrap">
                          {formatCurrency(inv.totalDue ?? inv.amount ?? 0)}
                        </td>
                        <td className="px-4 py-3.5 text-sm text-muted-foreground whitespace-nowrap">
                          {dueLabel}
                        </td>
                        <td className="px-4 py-3.5">
                          {(inv.daysLate ?? 0) > 0 ? (
                            <span
                              className={`text-sm font-bold ${
                                (inv.daysLate ?? 0) > 30
                                  ? "text-red-400"
                                  : (inv.daysLate ?? 0) > 10
                                  ? "text-orange-400"
                                  : "text-amber-400"
                              }`}
                            >
                              {inv.daysLate}d
                            </span>
                          ) : (
                            <span className="text-sm text-muted-foreground/40">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3.5">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${sc.cls}`}>
                            {sc.label}
                          </span>
                        </td>
                        <td className="px-4 py-3.5">
                          <div className="flex items-center gap-1.5">
                            {waUrl && (
                              <a
                                href={waUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="w-7 h-7 rounded-lg bg-green-500/10 hover:bg-green-500/20 flex items-center justify-center transition-all"
                                title="WhatsApp"
                              >
                                <MessageCircle className="w-3.5 h-3.5 text-green-400" />
                              </a>
                            )}
                            <button
                              onClick={() => navigate("/invoices")}
                              className="w-7 h-7 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 flex items-center justify-center transition-all"
                              title="Ver cobrança"
                            >
                              <FileText className="w-3.5 h-3.5 text-blue-400" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* CHARTS */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Cashflow area chart */}
          <div className="lg:col-span-2 bg-card border border-border rounded-2xl p-5">
            <div className="flex items-center justify-between mb-5">
              <div>
                <p className="text-foreground font-semibold text-sm">Fluxo de Caixa</p>
                <p className="text-muted-foreground text-xs">Evolução diária</p>
              </div>
              <div className="flex gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-green-400" />
                  Entradas
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-amber-400" />
                  Saldo
                </span>
              </div>
            </div>

            {formattedDaily.length === 0 ? (
              <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
                Sem lançamentos de caixa ainda
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={formattedDaily}>
                  <defs>
                    <linearGradient id="gIncome" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#22c55e" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gNet" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="dateLabel"
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) =>
                      v >= 1000 ? `R$${(v / 1000).toFixed(0)}k` : `R$${v}`
                    }
                  />
                  <Tooltip
                    formatter={(value: number) => formatCurrency(value)}
                    contentStyle={{
                      background: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: 10,
                      fontSize: 12,
                    }}
                    labelStyle={{ color: "hsl(var(--foreground))" }}
                  />
                  <Area
                    type="monotone"
                    dataKey="income"
                    name="Entradas"
                    stroke="#22c55e"
                    strokeWidth={2}
                    fill="url(#gIncome)"
                  />
                  <Area
                    type="monotone"
                    dataKey="net"
                    name="Saldo"
                    stroke="#f59e0b"
                    strokeWidth={2}
                    fill="url(#gNet)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Carteira Donut */}
          <div className="bg-card border border-border rounded-2xl p-5 flex flex-col">
            <p className="text-foreground font-semibold text-sm mb-1">Carteira</p>
            <p className="text-muted-foreground text-xs mb-4">Distribuição financeira</p>

            {carteiraData.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                Sem dados financeiros ainda
              </div>
            ) : (
              <>
                <div className="flex-1 flex items-center justify-center">
                  <ResponsiveContainer width="100%" height={160}>
                    <PieChart>
                      <Pie
                        data={carteiraData}
                        cx="50%"
                        cy="50%"
                        innerRadius={50}
                        outerRadius={75}
                        paddingAngle={3}
                        dataKey="value"
                      >
                        {carteiraData.map((entry, index) => (
                          <Cell key={index} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(value: number) => formatCurrency(value)}
                        contentStyle={{
                          background: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="space-y-2 mt-2">
                  {carteiraData.map((d) => (
                    <div key={d.name} className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-2 text-muted-foreground">
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ background: d.color }}
                        />
                        {d.name}
                      </span>
                      <span className="font-bold text-foreground">
                        {totalCarteira > 0
                          ? `${Math.round((d.value / totalCarteira) * 100)}%`
                          : "—"}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
