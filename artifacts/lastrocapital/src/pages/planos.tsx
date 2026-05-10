import { useState } from "react";
import { Check, Crown, Building2, AlertCircle, Loader2, Phone, Gift, CreditCard, ShieldCheck } from "lucide-react";
import { useGetMySubscription, useCreateSubscription, useStartFreeTrial } from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout/app-layout";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

const PLANOS = [
  {
    key: "free" as const,
    name: "Free Trial",
    price: "R$0,00",
    period: " por 15 dias",
    description: "Experimente gratuitamente por 15 dias sem precisar de cartão.",
    icon: Gift,
    color: "text-green-400",
    borderColor: "border-green-500/30",
    bgColor: "bg-green-500/5",
    badge: "Comece grátis",
    buttonLabel: "Começar grátis",
    features: [
      "Até 5 clientes",
      "Até 30 lançamentos no fluxo de caixa",
      "Até 15 cobranças",
      "Controle de dívidas",
      "Suporte por e-mail",
    ],
  },
  {
    key: "pro" as const,
    name: "Pro",
    price: "R$59,90",
    period: "/mês",
    description: "Para empresas em crescimento com mais demanda.",
    icon: Crown,
    color: "text-amber-400",
    borderColor: "border-amber-500/50",
    bgColor: "bg-amber-500/5",
    highlight: true,
    badge: "Mais popular",
    buttonLabel: "Assinar Pro",
    features: [
      "Até 50 clientes",
      "Até 300 lançamentos no fluxo de caixa",
      "Até 100 cobranças",
      "Link de convite para clientes",
      "Notificações via WhatsApp",
      "Suporte prioritário",
    ],
  },
  {
    key: "enterprise" as const,
    name: "Empresa",
    price: "R$99,90",
    period: "/mês",
    description: "Clientes ilimitados e todos os recursos sem restrições.",
    icon: Building2,
    color: "text-purple-400",
    borderColor: "border-purple-500/30",
    bgColor: "bg-purple-500/5",
    buttonLabel: "Assinar Empresa",
    features: [
      "Clientes ilimitados",
      "Lançamentos ilimitados",
      "Cobranças ilimitadas",
      "Todos os recursos sem limites",
      "Gerente de conta dedicado",
      "SLA garantido",
    ],
  },
];

const STATUS_LABELS: Record<string, string> = {
  trial: "Trial ativo",
  pending: "Aguardando pagamento",
  active: "Ativa",
  past_due: "Pagamento pendente",
  canceled: "Cancelada",
};

const PLAN_LABELS: Record<string, string> = {
  free: "Free Trial",
  pro: "Pro",
  enterprise: "Empresa",
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("pt-BR");
}

export default function Planos() {
  const { toast } = useToast();
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);
  const [pendingPaidPlan, setPendingPaidPlan] = useState<"pro" | "enterprise" | null>(null);
  const [phone, setPhone] = useState("");
  const [cnpj, setCnpj] = useState("");

  const { data: subscription, isLoading: subLoading, refetch } = useGetMySubscription();
  const { mutateAsync: createSubscription } = useCreateSubscription();
  const { mutateAsync: startTrial } = useStartFreeTrial();

  const searchParams = new URLSearchParams(window.location.search);
  const statusParam = searchParams.get("status");

  async function handleStartTrial() {
    setLoadingPlan("free");
    try {
      await startTrial();
      await refetch();
      toast({ title: "Trial de 15 dias ativado!", description: "Aproveite o acesso completo." });
    } catch (err: any) {
      const code = err?.response?.data?.code;
      if (code === "SUBSCRIPTION_EXISTS") {
        toast({ title: "Você já possui uma assinatura.", variant: "default" });
      } else {
        toast({ title: "Erro ao ativar trial", description: "Tente novamente em instantes.", variant: "destructive" });
      }
    } finally {
      setLoadingPlan(null);
    }
  }

  function handlePaidPlan(planKey: "pro" | "enterprise") {
    if (subscription?.status === "active" && subscription.plan === planKey) {
      toast({ title: "Você já possui este plano ativo.", variant: "default" });
      return;
    }
    setPendingPaidPlan(planKey);
  }

  function handlePlanClick(planKey: "free" | "pro" | "enterprise") {
    if (planKey === "free") {
      handleStartTrial();
    } else {
      handlePaidPlan(planKey);
    }
  }

  const cnpjDigits = cnpj.replace(/\D/g, "");

  async function handleConfirmCheckout() {
    if (!pendingPaidPlan) return;
    if (!cnpjDigits || (cnpjDigits.length !== 11 && cnpjDigits.length !== 14)) {
      toast({ title: "Informe um CNPJ ou CPF válido para continuar.", variant: "destructive" });
      return;
    }
    const planKey = pendingPaidPlan;
    setPendingPaidPlan(null);
    setLoadingPlan(planKey);
    try {
      const result = await createSubscription({
        data: { plan: planKey, phone: phone.replace(/\D/g, "") || undefined, cnpj: cnpjDigits },
      });
      if (result.checkoutUrl) {
        window.location.href = result.checkoutUrl;
      }
    } catch (err: any) {
      const code = err?.response?.data?.code;
      toast({
        title: "Erro ao criar assinatura",
        description: code === "CNPJ_REQUIRED" ? "Informe o CNPJ ou CPF para continuar." : "Tente novamente em alguns instantes.",
        variant: "destructive",
      });
      setLoadingPlan(null);
    }
  }

  function isCurrentPlan(planKey: string): boolean {
    if (!subscription) return false;
    if (planKey === "free") return subscription.status === "trial";
    return subscription.plan === planKey && subscription.status === "active";
  }

  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div className="text-center mb-10">
          <div className="flex items-center justify-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center">
              <ShieldCheck className="h-6 w-6 text-white" />
            </div>
            <span className="text-2xl font-bold tracking-tight text-foreground">LastroCapital</span>
          </div>
          <h1 className="text-3xl font-bold text-foreground mb-2">Escolha seu plano</h1>
          <p className="text-muted-foreground text-base">
            Gerencie suas finanças com toda a praticidade do LastroCapital.
          </p>
        </div>

        {statusParam === "success" && (
          <div className="mb-6 flex items-center gap-3 bg-green-500/10 border border-green-500/30 text-green-400 rounded-lg p-4">
            <Check className="h-5 w-5 shrink-0" />
            <span>Pagamento recebido! Sua assinatura será ativada em instantes.</span>
          </div>
        )}

        {statusParam === "pending" && (
          <div className="mb-6 flex items-center gap-3 bg-amber-500/10 border border-amber-500/30 text-amber-400 rounded-lg p-4">
            <AlertCircle className="h-5 w-5 shrink-0" />
            <span>Aguardando confirmação do pagamento. Você receberá um aviso assim que for confirmado.</span>
          </div>
        )}

        {!subLoading && subscription && (
          <div className="mb-8 flex items-center gap-3 bg-card border border-border rounded-lg p-4">
            <div className="flex-1">
              <p className="text-sm text-muted-foreground">Assinatura atual</p>
              <p className="font-semibold text-foreground">
                Plano {PLAN_LABELS[subscription.plan] ?? subscription.plan}
                {" — "}
                <span
                  className={
                    subscription.status === "active" || subscription.status === "trial"
                      ? "text-green-400"
                      : subscription.status === "pending"
                        ? "text-amber-400"
                        : "text-red-400"
                  }
                >
                  {STATUS_LABELS[subscription.status] ?? subscription.status}
                </span>
              </p>
              {subscription.status === "trial" && subscription.expiresAt && (
                <p className="text-xs text-muted-foreground mt-1">
                  Expira em {formatDate(subscription.expiresAt)}
                </p>
              )}
            </div>
            {subscription.status === "pending" && subscription.checkoutUrl && (
              <a
                href={subscription.checkoutUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-medium text-amber-400 hover:underline"
              >
                Concluir pagamento →
              </a>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {PLANOS.map((plano) => {
            const Icon = plano.icon;
            const active = isCurrentPlan(plano.key);
            const isLoading = loadingPlan === plano.key;

            return (
              <div
                key={plano.key}
                className={`relative flex flex-col rounded-xl border p-6 transition-all ${plano.borderColor} ${plano.bgColor} ${
                  plano.highlight ? "ring-2 ring-amber-500/40 shadow-lg shadow-amber-500/10" : ""
                }`}
              >
                {plano.badge && (
                  <span
                    className={`absolute -top-3 left-1/2 -translate-x-1/2 text-xs font-bold px-3 py-1 rounded-full ${
                      plano.key === "free"
                        ? "bg-green-500 text-black"
                        : "bg-amber-500 text-black"
                    }`}
                  >
                    {plano.badge}
                  </span>
                )}

                <div className={`mb-4 ${plano.color}`}>
                  <Icon className="h-7 w-7" />
                </div>

                <h2 className="text-lg font-bold text-foreground mb-1">{plano.name}</h2>
                <p className="text-sm text-muted-foreground mb-4">{plano.description}</p>

                <div className="mb-6">
                  <span className="text-3xl font-extrabold text-foreground">{plano.price}</span>
                  <span className="text-muted-foreground text-sm">{plano.period}</span>
                </div>

                <ul className="space-y-2 mb-8 flex-1">
                  {plano.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-sm text-muted-foreground">
                      <Check className={`h-4 w-4 mt-0.5 shrink-0 ${plano.color}`} />
                      {f}
                    </li>
                  ))}
                </ul>

                <button
                  onClick={() => handlePlanClick(plano.key)}
                  disabled={isLoading || active}
                  className={`w-full py-2.5 rounded-lg font-semibold text-sm transition-all flex items-center justify-center gap-2 ${
                    active
                      ? "bg-green-500/20 text-green-400 border border-green-500/30 cursor-default"
                      : plano.key === "free"
                        ? "bg-green-500 hover:bg-green-400 text-black disabled:opacity-60"
                        : plano.highlight
                          ? "bg-amber-500 hover:bg-amber-400 text-black disabled:opacity-60"
                          : "bg-card border border-border hover:border-muted-foreground text-foreground disabled:opacity-60"
                  }`}
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Aguarde...
                    </>
                  ) : active ? (
                    <>
                      <Check className="h-4 w-4" />
                      Plano atual
                    </>
                  ) : (
                    plano.buttonLabel
                  )}
                </button>
              </div>
            );
          })}
        </div>

        <p className="text-center text-xs text-muted-foreground mt-8">
          Pagamentos processados com segurança pelo AbacatePay via PIX. Cancele quando quiser.
        </p>
      </div>

      <Dialog open={!!pendingPaidPlan} onOpenChange={(open) => { if (!open) setPendingPaidPlan(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Confirmar assinatura</DialogTitle>
            <DialogDescription>
              Preencha os dados abaixo para ir ao checkout PIX.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="cnpj-input" className="flex items-center gap-2">
                <CreditCard className="h-4 w-4" />
                CNPJ / CPF <span className="text-red-400">*</span>
              </Label>
              <Input
                id="cnpj-input"
                inputMode="numeric"
                placeholder="00.000.000/0001-00 ou 000.000.000-00"
                value={cnpj}
                onChange={(e) => {
                  const digits = e.target.value.replace(/\D/g, "").slice(0, 14);
                  if (digits.length <= 11) {
                    setCnpj(digits.replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d{1,2})$/, "$1-$2"));
                  } else {
                    setCnpj(digits.replace(/(\d{2})(\d)/, "$1.$2").replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d)/, "$1/$2").replace(/(\d{4})(\d{1,2})$/, "$1-$2"));
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">Obrigatório para identificação no pagamento PIX.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="phone-input" className="flex items-center gap-2">
                <Phone className="h-4 w-4" />
                Celular (opcional)
              </Label>
              <Input
                id="phone-input"
                type="tel"
                placeholder="(11) 99999-9999"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleConfirmCheckout(); }}
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPendingPaidPlan(null)}>
              Cancelar
            </Button>
            <Button onClick={handleConfirmCheckout} className="bg-amber-500 hover:bg-amber-400 text-black font-semibold">
              Ir para o pagamento
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
