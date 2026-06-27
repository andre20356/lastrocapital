import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useUser, useClerk } from "@clerk/react";
import {
  Users,
  Wifi,
  CreditCard,
  RefreshCw,
  LogOut,
  ShieldCheck,
  Trash2,
  Loader2,
  WifiOff,
  WifiHigh,
  CheckCircle2,
  Clock,
  XCircle,
  AlertTriangle,
  Building2,
} from "lucide-react";
import { useState } from "react";

interface Subscription {
  status: string;
  expiresAt: string | null;
}

interface Subscriber {
  id: number;
  name: string;
  cnpj: string | null;
  plan: string;
  clerkUserId: string;
  whatsappInstance: string | null;
  whatsappStatus: string;
  whatsappPhone: string | null;
  createdAt: string;
  subscription: Subscription | null;
}

interface Stats {
  totalSubscribers: number;
  connectedWhatsapp: number;
  activeSubscriptions: number;
}

interface Props {
  authFetch: (url: string, opts?: RequestInit) => Promise<any>;
}

const PLAN_LABELS: Record<string, { label: string; color: string }> = {
  free:       { label: "Free Trial",  color: "bg-slate-700 text-slate-300" },
  pro:        { label: "Pro",         color: "bg-amber-500/20 text-amber-300 border border-amber-500/40" },
  enterprise: { label: "Empresa",     color: "bg-purple-500/20 text-purple-300 border border-purple-500/40" },
};

const SUB_STATUS: Record<string, { label: string; color: string; Icon: typeof CheckCircle2 }> = {
  trial:    { label: "Trial",     color: "text-blue-400",   Icon: Clock },
  active:   { label: "Ativa",     color: "text-emerald-400", Icon: CheckCircle2 },
  pending:  { label: "Pendente",  color: "text-amber-400",  Icon: Clock },
  past_due: { label: "Vencida",   color: "text-red-400",    Icon: AlertTriangle },
  canceled: { label: "Cancelada", color: "text-slate-500",  Icon: XCircle },
};

function WaStatusBadge({ status }: { status: string }) {
  if (status === "connected") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
        <WifiHigh className="w-3.5 h-3.5" /> Conectado
      </span>
    );
  }
  if (status === "connecting") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400">
        <Wifi className="w-3.5 h-3.5 animate-pulse" /> Conectando
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
      <WifiOff className="w-3.5 h-3.5" /> Desconectado
    </span>
  );
}

function PlanBadge({ plan }: { plan: string }) {
  const p = PLAN_LABELS[plan] ?? { label: plan, color: "bg-slate-700 text-slate-300" };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${p.color}`}>
      {p.label}
    </span>
  );
}

function SubStatus({ sub }: { sub: Subscription | null }) {
  if (!sub) return <span className="text-xs text-slate-600">—</span>;
  const s = SUB_STATUS[sub.status] ?? { label: sub.status, color: "text-slate-400", Icon: Clock };
  const Icon = s.Icon;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${s.color}`}>
      <Icon className="w-3.5 h-3.5" />
      {s.label}
      {sub.expiresAt && (
        <span className="text-slate-500 font-normal ml-1">
          até {new Date(sub.expiresAt).toLocaleDateString("pt-BR")}
        </span>
      )}
    </span>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: typeof Users;
  label: string;
  value: number | undefined;
  color: string;
}) {
  return (
    <div className="bg-[#1a1f2e] border border-slate-800 rounded-xl p-5 flex items-center gap-4">
      <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${color}`}>
        <Icon className="w-6 h-6 text-white" />
      </div>
      <div>
        <p className="text-2xl font-bold text-white">
          {value === undefined ? <Loader2 className="w-5 h-5 animate-spin text-slate-500" /> : value}
        </p>
        <p className="text-xs text-slate-400 mt-0.5">{label}</p>
      </div>
    </div>
  );
}

export default function Dashboard({ authFetch }: Props) {
  const qc = useQueryClient();
  const { user } = useUser();
  const { signOut } = useClerk();
  const [disconnecting, setDisconnecting] = useState<number | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);

  const {
    data: stats,
    isLoading: statsLoading,
    refetch: refetchStats,
  } = useQuery<Stats>({
    queryKey: ["admin-stats"],
    queryFn: () => authFetch("/api/admin/stats"),
    refetchInterval: 30_000,
  });

  const {
    data: subscribers,
    isLoading: subsLoading,
    isFetching,
    refetch: refetchSubs,
  } = useQuery<Subscriber[]>({
    queryKey: ["admin-subscribers"],
    queryFn: () => authFetch("/api/admin/subscribers"),
    refetchInterval: 30_000,
  });

  const disconnectMutation = useMutation({
    mutationFn: (id: number) =>
      authFetch(`/api/admin/subscribers/${id}/whatsapp`, { method: "DELETE" }),
    onMutate: (id) => setDisconnecting(id),
    onSettled: () => {
      setDisconnecting(null);
      setConfirmId(null);
      qc.invalidateQueries({ queryKey: ["admin-stats"] });
      qc.invalidateQueries({ queryKey: ["admin-subscribers"] });
    },
  });

  function handleRefresh() {
    refetchStats();
    refetchSubs();
  }

  return (
    <div className="min-h-screen bg-[#0f1117] flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-[#0f1117]/90 backdrop-blur border-b border-slate-800 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center">
            <ShieldCheck className="w-4 h-4 text-white" />
          </div>
          <span className="font-bold text-white">LastroAdmin</span>
          <span className="text-slate-600 text-sm hidden sm:block">/ Painel de Controle</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-slate-400 hidden sm:block">
            {user?.primaryEmailAddress?.emailAddress}
          </span>
          <button
            onClick={() => signOut()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm transition"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sair
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-8 space-y-8">
        {/* Title row */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Assistentes SaaS</h1>
            <p className="text-sm text-slate-400 mt-1">
              Visão geral de todas as empresas e seus bots WhatsApp
            </p>
          </div>
          <button
            onClick={handleRefresh}
            disabled={isFetching}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm transition disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} />
            Atualizar
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard
            icon={Building2}
            label="Total de Empresas"
            value={statsLoading ? undefined : stats?.totalSubscribers}
            color="bg-indigo-600"
          />
          <StatCard
            icon={Wifi}
            label="WhatsApp Conectados"
            value={statsLoading ? undefined : stats?.connectedWhatsapp}
            color="bg-emerald-600"
          />
          <StatCard
            icon={CreditCard}
            label="Assinaturas Ativas"
            value={statsLoading ? undefined : stats?.activeSubscriptions}
            color="bg-purple-600"
          />
        </div>

        {/* Table */}
        <div className="bg-[#1a1f2e] border border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-slate-400" />
              <span className="font-semibold text-white text-sm">Empresas Assinantes</span>
              {subscribers && (
                <span className="px-2 py-0.5 rounded-full bg-slate-700 text-xs text-slate-300 font-medium">
                  {subscribers.length}
                </span>
              )}
            </div>
          </div>

          {subsLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
            </div>
          ) : !subscribers?.length ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-500">
              <Users className="w-8 h-8 mb-3 opacity-40" />
              <p className="text-sm">Nenhuma empresa cadastrada ainda</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800">
                    {["Empresa", "Plano", "WhatsApp", "Assinatura", "Cadastro", "Ações"].map((h) => (
                      <th
                        key={h}
                        className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {subscribers.map((sub) => (
                    <tr key={sub.id} className="hover:bg-slate-800/30 transition">
                      {/* Empresa */}
                      <td className="px-5 py-4">
                        <div className="font-medium text-white">{sub.name}</div>
                        {sub.cnpj && (
                          <div className="text-xs text-slate-500 mt-0.5">{sub.cnpj}</div>
                        )}
                      </td>

                      {/* Plano */}
                      <td className="px-5 py-4">
                        <PlanBadge plan={sub.plan} />
                      </td>

                      {/* WhatsApp */}
                      <td className="px-5 py-4">
                        <WaStatusBadge status={sub.whatsappStatus} />
                        {sub.whatsappPhone && (
                          <div className="text-xs text-slate-500 mt-1">{sub.whatsappPhone}</div>
                        )}
                        {sub.whatsappInstance && (
                          <div className="text-xs text-slate-600 font-mono mt-0.5">{sub.whatsappInstance}</div>
                        )}
                      </td>

                      {/* Assinatura */}
                      <td className="px-5 py-4">
                        <SubStatus sub={sub.subscription} />
                      </td>

                      {/* Cadastro */}
                      <td className="px-5 py-4 text-xs text-slate-400 whitespace-nowrap">
                        {new Date(sub.createdAt).toLocaleDateString("pt-BR")}
                      </td>

                      {/* Ações */}
                      <td className="px-5 py-4">
                        {sub.whatsappInstance ? (
                          confirmId === sub.id ? (
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => disconnectMutation.mutate(sub.id)}
                                disabled={disconnecting === sub.id}
                                className="px-2.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-medium transition flex items-center gap-1 disabled:opacity-60"
                              >
                                {disconnecting === sub.id ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  <Trash2 className="w-3 h-3" />
                                )}
                                Confirmar
                              </button>
                              <button
                                onClick={() => setConfirmId(null)}
                                className="px-2.5 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs transition"
                              >
                                Cancelar
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setConfirmId(sub.id)}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-700 hover:bg-red-900/50 hover:text-red-400 text-slate-400 text-xs transition"
                            >
                              <WifiOff className="w-3 h-3" />
                              Desconectar WA
                            </button>
                          )
                        ) : (
                          <span className="text-xs text-slate-700">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
