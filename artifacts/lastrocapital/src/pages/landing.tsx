import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Sun, Moon, BarChart3, Users, ShieldCheck, Share2, Check } from "lucide-react";
import { useTheme } from "@/hooks/use-theme";

export default function Landing() {
  const { theme, toggle } = useTheme();
  const [, navigate] = useLocation();
  const [copied, setCopied] = useState(false);

  const handleShare = async () => {
    const url = window.location.origin;
    const shareData = {
      title: "LastroCapital",
      text: "Gerencie suas finanças com o LastroCapital — controle de clientes, cobranças e fluxo de caixa para empresas brasileiras.",
      url,
    };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
      } catch {
        // user cancelled
      }
    } else {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <header className="flex items-center justify-between px-8 py-5 border-b border-border bg-card shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary flex items-center justify-center">
            <ShieldCheck className="h-5 w-5 text-primary-foreground" />
          </div>
          <span className="text-xl font-bold tracking-tight text-foreground">LastroCapital</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={toggle}
            className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label="Alternar modo escuro/claro"
          >
            {theme === "dark" ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </button>
          <button
            onClick={handleShare}
            className="flex items-center gap-1.5 p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors text-sm"
            aria-label="Compartilhar"
          >
            {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Share2 className="h-4 w-4" />}
            {copied ? "Copiado!" : "Compartilhar"}
          </button>
          <button
            onClick={() => navigate("/sign-in")}
            className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Entrar
          </button>
          <Button size="sm" onClick={() => navigate("/sign-up")}>Criar conta</Button>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center text-center px-4 py-16">
        <div className="inline-flex items-center gap-2 bg-primary/10 text-primary text-sm font-medium px-4 py-1.5 rounded-full mb-8 border border-primary/20">
          <ShieldCheck className="h-4 w-4" />
          Gestão financeira para empresas brasileiras
        </div>
        <h1 className="text-5xl font-bold tracking-tight text-foreground max-w-3xl mb-6 leading-tight">
          O controle financeiro completo para o seu negócio.
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl mb-10">
          Gerencie clientes, fluxo de caixa e cobranças com precisão. Simples, rápido e feito para a realidade brasileira.
        </p>
        <div className="flex gap-4 flex-wrap justify-center">
          <Button size="lg" className="text-base px-8 h-12" onClick={() => navigate("/sign-up")}>
            Começar gratuitamente
          </Button>
          <Button size="lg" variant="outline" className="text-base px-8 h-12" onClick={() => navigate("/sign-in")}>
            Já tenho conta
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-20 max-w-4xl w-full">
          <div className="bg-card border border-border rounded-xl p-6 text-left shadow-sm">
            <BarChart3 className="h-8 w-8 text-primary mb-4" />
            <h3 className="font-semibold text-foreground mb-2">Fluxo de Caixa</h3>
            <p className="text-sm text-muted-foreground">Acompanhe entradas e saídas em tempo real com relatórios por categoria.</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-6 text-left shadow-sm">
            <Users className="h-8 w-8 text-primary mb-4" />
            <h3 className="font-semibold text-foreground mb-2">Gestão de Clientes</h3>
            <p className="text-sm text-muted-foreground">Cadastre clientes, envie cobranças e acompanhe inadimplentes com facilidade.</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-6 text-left shadow-sm">
            <ShieldCheck className="h-8 w-8 text-primary mb-4" />
            <h3 className="font-semibold text-foreground mb-2">Segurança Total</h3>
            <p className="text-sm text-muted-foreground">Seus dados protegidos com autenticação segura e isolamento por empresa.</p>
          </div>
        </div>
      </main>

      <footer className="border-t border-border py-6 text-center text-sm text-muted-foreground">
        © {new Date().getFullYear()} LastroCapital. Todos os direitos reservados.
      </footer>
    </div>
  );
}
