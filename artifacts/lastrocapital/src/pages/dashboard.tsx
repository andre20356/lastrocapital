import {
  useGetDashboardSummary,
  getGetDashboardSummaryQueryKey,
  useGetDashboardCashflowDaily,
  getGetDashboardCashflowDailyQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/format";
import { Users, TrendingUp, Wallet, AlertCircle, FileText, HandCoins, SendHorizonal } from "lucide-react";
import { AppLayout } from "@/components/layout/app-layout";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";

const PIE_COLORS = ["#10b981", "#ef4444", "#f59e0b", "#6366f1"];

const formatCurrencyShort = (value: number) => {
  if (value >= 1000) return `R$ ${(value / 1000).toFixed(1)}k`;
  return `R$ ${value.toFixed(0)}`;
};

export default function Dashboard() {
  const { data: summary, isLoading } = useGetDashboardSummary({
    query: { queryKey: getGetDashboardSummaryQueryKey() },
  });

  const { data: dailyData } = useGetDashboardCashflowDaily({
    query: { queryKey: getGetDashboardCashflowDailyQueryKey() },
  });

  if (isLoading) {
    return (
      <AppLayout>
        <div className="animate-pulse text-muted-foreground">Carregando...</div>
      </AppLayout>
    );
  }

  if (!summary) return null;

  const pieData = [
    { name: "Receita", value: summary.totalIncome },
    { name: "Despesas", value: summary.totalExpenses },
    { name: "Lucro", value: Math.max(0, summary.netBalance) },
    { name: "Inadimplência", value: summary.overdueDebtsTotal },
  ].filter((d) => d.value > 0);

  const formattedDaily = (dailyData ?? []).map((d) => ({
    ...d,
    dateLabel: new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" }).format(
      new Date(d.date + "T00:00:00")
    ),
  }));

  return (
    <AppLayout>
      <h1 className="text-2xl md:text-3xl font-bold mb-6 md:mb-8">Painel</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Juros a Receber</CardTitle>
            <Wallet className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{formatCurrency(summary.totalInterestDue)}</div>
            <p className="text-xs text-muted-foreground">juros mensais de cobranças ativas</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total de Entradas</CardTitle>
            <TrendingUp className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-500">{formatCurrency(summary.totalIncome)}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Emprestado Hoje</CardTitle>
            <SendHorizonal className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-500">{formatCurrency(summary.todayLoaned)}</div>
            <p className="text-xs text-muted-foreground">cobranças criadas hoje</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Cobranças Pendentes</CardTitle>
            <FileText className="h-4 w-4 text-orange-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-orange-500">{formatCurrency(summary.pendingInvoicesTotal)}</div>
            <p className="text-xs text-muted-foreground">{summary.pendingInvoicesCount} cobrança(s)</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Dívidas em Atraso</CardTitle>
            <AlertCircle className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">{formatCurrency(summary.overdueDebtsTotal)}</div>
            <p className="text-xs text-muted-foreground">{summary.overdueDebtsCount} dívida(s)</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Clientes Ativos</CardTitle>
            <Users className="h-4 w-4 text-violet-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-violet-500">{summary.activeClients}</div>
            <p className="text-xs text-muted-foreground">de {summary.totalClients} no total</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Emprestado</CardTitle>
            <HandCoins className="h-4 w-4 text-cyan-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-cyan-500">{formatCurrency(summary.totalLoaned)}</div>
            <p className="text-xs text-muted-foreground">cobranças pendentes + vencidas</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Visão Financeira Geral</CardTitle>
          </CardHeader>
          <CardContent>
            {pieData.length === 0 ? (
              <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
                Sem dados financeiros ainda
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={3}
                    dataKey="value"
                  >
                    {pieData.map((_, index) => (
                      <Cell key={index} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value: number) => formatCurrency(value)}
                    contentStyle={{ background: "hsl(220 15% 18%)", border: "1px solid hsl(220 15% 25%)", borderRadius: "8px" }}
                    labelStyle={{ color: "hsl(220 10% 98%)" }}
                    itemStyle={{ color: "hsl(220 10% 80%)" }}
                  />
                  <Legend
                    formatter={(value) => <span style={{ color: "hsl(220 10% 80%)", fontSize: "13px" }}>{value}</span>}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Evolução Diária do Caixa</CardTitle>
          </CardHeader>
          <CardContent>
            {formattedDaily.length === 0 ? (
              <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
                Sem lançamentos de caixa ainda
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={formattedDaily} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(220 15% 22%)" />
                  <XAxis
                    dataKey="dateLabel"
                    tick={{ fill: "hsl(220 10% 60%)", fontSize: 11 }}
                    tickLine={false}
                  />
                  <YAxis
                    tickFormatter={formatCurrencyShort}
                    tick={{ fill: "hsl(220 10% 60%)", fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    formatter={(value: number) => formatCurrency(value)}
                    contentStyle={{ background: "hsl(220 15% 18%)", border: "1px solid hsl(220 15% 25%)", borderRadius: "8px" }}
                    labelStyle={{ color: "hsl(220 10% 98%)" }}
                    itemStyle={{ color: "hsl(220 10% 80%)" }}
                  />
                  <Legend
                    formatter={(value) => <span style={{ color: "hsl(220 10% 80%)", fontSize: "13px" }}>{
                      value === "income" ? "Entradas" : value === "expense" ? "Saídas" : "Lucro líquido"
                    }</span>}
                  />
                  <Bar dataKey="income" name="income" fill="#10b981" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="expense" name="expense" fill="#ef4444" radius={[3, 3, 0, 0]} />
                  <Line dataKey="net" name="net" type="monotone" stroke="#f59e0b" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
