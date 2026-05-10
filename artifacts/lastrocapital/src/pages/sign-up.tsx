import { SignUp } from "@clerk/react";
import { ShieldCheck, CheckCircle2, TrendingUp, Users, FileText } from "lucide-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

const features = [
  "Controle de clientes e inadimplentes",
  "Fluxo de caixa por categoria",
  "Cobranças com juros e multa automáticos",
  "Relatórios financeiros em tempo real",
];

export default function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh]">
      <div className="hidden lg:flex lg:w-[480px] xl:w-[520px] bg-[hsl(142,65%,14%)] flex-col justify-between p-12 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center">
            <ShieldCheck className="h-6 w-6 text-white" />
          </div>
          <span className="text-xl font-bold text-white tracking-tight">LastroCapital</span>
        </div>

        <div className="space-y-10">
          <div>
            <div className="inline-flex items-center gap-2 bg-[hsl(142,72%,29%)]/40 text-[hsl(142,72%,65%)] text-sm font-medium px-4 py-1.5 rounded-full mb-6 border border-[hsl(142,72%,29%)]/50">
              15 dias grátis — sem cartão de crédito
            </div>
            <h1 className="text-4xl font-bold text-white leading-tight mb-4">
              Comece a organizar suas finanças hoje
            </h1>
            <p className="text-white/60 text-lg leading-relaxed">
              Crie sua conta grátis e tenha acesso completo por 15 dias sem precisar de cartão.
            </p>
          </div>

          <div className="space-y-4">
            {features.map((f) => (
              <div key={f} className="flex items-center gap-3">
                <CheckCircle2 className="h-5 w-5 text-[hsl(142,72%,50%)] shrink-0" />
                <span className="text-white/80 text-sm">{f}</span>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-3 gap-4 pt-2">
            <div className="bg-white/5 rounded-xl p-4 border border-white/10">
              <TrendingUp className="h-5 w-5 text-[hsl(142,72%,50%)] mb-2" />
              <p className="text-white font-bold text-lg">R$ 0</p>
              <p className="text-white/50 text-xs">para começar</p>
            </div>
            <div className="bg-white/5 rounded-xl p-4 border border-white/10">
              <Users className="h-5 w-5 text-[hsl(142,72%,50%)] mb-2" />
              <p className="text-white font-bold text-lg">15 dias</p>
              <p className="text-white/50 text-xs">grátis</p>
            </div>
            <div className="bg-white/5 rounded-xl p-4 border border-white/10">
              <FileText className="h-5 w-5 text-[hsl(142,72%,50%)] mb-2" />
              <p className="text-white font-bold text-lg">100%</p>
              <p className="text-white/50 text-xs">brasileiro</p>
            </div>
          </div>
        </div>

        <p className="text-white/25 text-sm">© {new Date().getFullYear()} LastroCapital. Todos os direitos reservados.</p>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center bg-[hsl(220,20%,97%)] px-6 py-12">
        <div className="w-full max-w-[440px]">
          <div className="flex items-center gap-2.5 mb-8 lg:hidden">
            <div className="w-8 h-8 rounded-lg bg-[hsl(142,72%,29%)] flex items-center justify-center">
              <ShieldCheck className="h-4 w-4 text-white" />
            </div>
            <span className="font-bold text-foreground text-lg">LastroCapital</span>
          </div>

          <div className="mb-6">
            <h2 className="text-2xl font-bold text-[hsl(220,25%,12%)] mb-1">Criar sua conta</h2>
            <p className="text-sm text-[hsl(220,15%,45%)]">Comece gratuitamente — sem cartão de crédito.</p>
          </div>

          <SignUp
            routing="path"
            path={`${basePath}/sign-up`}
            signInUrl={`${basePath}/sign-in`}
          />
        </div>
      </div>
    </div>
  );
}
