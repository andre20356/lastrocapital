import { Link, useLocation } from "wouter";
import { LayoutDashboard, Users, ArrowRightLeft, FileText, Landmark, LogOut, CreditCard, Sun, Moon, ShieldCheck, X, CalendarDays, RefreshCw } from "lucide-react";
import { useClerk } from "@clerk/react";
import { useTheme } from "@/hooks/use-theme";
import { useGetMySubscription } from "@workspace/api-client-react";

const navItems = [
  { href: "/dashboard", label: "Painel", icon: LayoutDashboard },
  { href: "/clients", label: "Clientes", icon: Users },
  { href: "/cashflow", label: "Fluxo de Caixa", icon: ArrowRightLeft },
  { href: "/invoices", label: "Cobranças", icon: FileText },
  { href: "/debts", label: "Dívidas", icon: Landmark },
  { href: "/planos", label: "Planos", icon: CreditCard },
];

const PLAN_LABEL: Record<string, string> = {
  trial: "Trial Grátis",
  pro: "Pro",
  enterprise: "Empresa",
};

const STATUS_COLOR: Record<string, string> = {
  trial: "text-amber-400",
  active: "text-emerald-400",
  pending: "text-blue-400",
  past_due: "text-red-400",
  canceled: "text-muted-foreground",
};

function formatShortDate(dateStr: string | null | undefined) {
  if (!dateStr) return "—";
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(dateStr));
}

interface SidebarProps {
  open?: boolean;
  onClose?: () => void;
}

export function Sidebar({ open = false, onClose }: SidebarProps) {
  const [location] = useLocation();
  const { signOut } = useClerk();
  const { theme, toggle } = useTheme();
  const { data: sub } = useGetMySubscription();

  return (
    <aside
      className={[
        "flex flex-col w-64 border-r border-sidebar-border bg-sidebar",
        "fixed inset-y-0 left-0 z-40 transition-transform duration-300",
        "md:relative md:inset-y-auto md:left-auto md:h-screen md:translate-x-0 md:shrink-0",
        open ? "translate-x-0" : "-translate-x-full md:translate-x-0",
      ].join(" ")}
      aria-hidden={!open ? true : undefined}
      inert={!open ? ("" as any) : undefined}
    >
      <div className="p-6 border-b border-sidebar-border flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-sidebar-accent flex items-center justify-center">
            <ShieldCheck className="h-4 w-4 text-sidebar-foreground" />
          </div>
          <span className="text-base font-bold tracking-tight text-sidebar-foreground">LastroCapital</span>
        </div>
        <button
          onClick={onClose}
          className="md:hidden p-1 rounded-lg text-sidebar-foreground/70 hover:text-sidebar-foreground"
          aria-label="Fechar menu"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = location === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onClose}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors text-sm font-medium ${
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* SUBSCRIPTION INFO */}
      {sub && (
        <div className="mx-4 mb-3 rounded-xl border border-sidebar-border bg-sidebar-accent/30 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-sidebar-foreground/60 uppercase tracking-wider">Plano</span>
            <span className={`text-xs font-bold ${STATUS_COLOR[sub.status] ?? "text-sidebar-foreground"}`}>
              {PLAN_LABEL[sub.plan] ?? sub.plan}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-sidebar-foreground/70">
            <CalendarDays className="h-3.5 w-3.5 shrink-0 text-sidebar-foreground/40" />
            <span>Assinado em <span className="font-medium text-sidebar-foreground/90">{formatShortDate(sub.startedAt ?? sub.createdAt)}</span></span>
          </div>
          <div className="flex items-center gap-2 text-xs text-sidebar-foreground/70">
            <RefreshCw className="h-3.5 w-3.5 shrink-0 text-sidebar-foreground/40" />
            <span>
              {sub.status === "trial" ? "Expira em" : "Renova em"}{" "}
              <span className={`font-medium ${sub.expiresAt && new Date(sub.expiresAt) < new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) ? "text-red-400" : "text-sidebar-foreground/90"}`}>
                {formatShortDate(sub.expiresAt)}
              </span>
            </span>
          </div>
        </div>
      )}

      <div className="p-4 border-t border-sidebar-border space-y-1">
        <button
          onClick={toggle}
          className="flex items-center gap-3 px-3 py-2.5 w-full rounded-lg text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground transition-colors text-sm font-medium"
          aria-label="Alternar modo escuro/claro"
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          {theme === "dark" ? "Modo claro" : "Modo escuro"}
        </button>
        <button
          onClick={() => signOut()}
          className="flex items-center gap-3 px-3 py-2.5 w-full rounded-lg text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground transition-colors text-sm font-medium"
        >
          <LogOut className="h-4 w-4" />
          Sair
        </button>
      </div>
    </aside>
  );
}
