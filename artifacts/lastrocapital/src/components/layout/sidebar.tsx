import { Link, useLocation } from "wouter";
import { LayoutDashboard, Users, ArrowRightLeft, FileText, Landmark, LogOut, CreditCard, Sun, Moon, ShieldCheck, X } from "lucide-react";
import { useClerk } from "@clerk/react";
import { useTheme } from "@/hooks/use-theme";

const navItems = [
  { href: "/dashboard", label: "Painel", icon: LayoutDashboard },
  { href: "/clients", label: "Clientes", icon: Users },
  { href: "/cashflow", label: "Fluxo de Caixa", icon: ArrowRightLeft },
  { href: "/invoices", label: "Cobranças", icon: FileText },
  { href: "/debts", label: "Dívidas", icon: Landmark },
  { href: "/planos", label: "Planos", icon: CreditCard },
];

interface SidebarProps {
  open?: boolean;
  onClose?: () => void;
}

export function Sidebar({ open = false, onClose }: SidebarProps) {
  const [location] = useLocation();
  const { signOut } = useClerk();
  const { theme, toggle } = useTheme();

  return (
    <aside
      className={[
        "flex flex-col w-64 border-r border-sidebar-border bg-sidebar",
        "fixed inset-y-0 left-0 z-40 transition-transform duration-300",
        "md:relative md:inset-y-auto md:left-auto md:h-screen md:translate-x-0 md:shrink-0",
        open ? "translate-x-0" : "-translate-x-full",
      ].join(" ")}
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
