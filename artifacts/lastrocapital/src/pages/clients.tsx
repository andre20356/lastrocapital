import { useState } from "react";
import { useListClients, getListClientsQueryKey, useCreateClient, useUpdateClient, useDeleteClient, useGetMyCompany, useListInvoices } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useForm } from "react-hook-form";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Plus, Pencil, Trash2, Search, Users, MessageCircle,
  AlertTriangle, Bell, Filter, UserCheck, UserX, ShieldAlert,
} from "lucide-react";

import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/format";

function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
      <path d="M12 0C5.373 0 0 5.373 0 12c0 2.116.553 4.103 1.523 5.824L.057 23.5l5.83-1.529A11.944 11.944 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.818 9.818 0 01-5.007-1.373l-.36-.214-3.724.977.995-3.63-.234-.374A9.818 9.818 0 0112 2.182c5.422 0 9.818 4.396 9.818 9.818 0 5.423-4.396 9.818-9.818 9.818z"/>
    </svg>
  );
}

interface ClientFormData {
  name: string;
  phone: string;
  email: string;
  document: string;
  status: "active" | "inactive";
  referralSource: string;
}

function whatsappUrl(phone: string | null | undefined, name: string) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  const number = digits.startsWith("55") ? digits : `55${digits}`;
  const message = encodeURIComponent(
    `Olá ${name}, aqui é da LastroCapital. Estamos entrando em contato sobre sua situação financeira.`
  );
  return `https://wa.me/${number}?text=${message}`;
}

export default function Clients() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<"active" | "inactive" | "all">("all");
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);

  const { data: clients, isLoading } = useListClients(
    statusFilter !== "all" ? { status: statusFilter } : undefined,
    { query: { queryKey: getListClientsQueryKey(statusFilter !== "all" ? { status: statusFilter } : undefined) } }
  );

  const createClient = useCreateClient();
  const updateClient = useUpdateClient();
  const deleteClient = useDeleteClient();

  const form = useForm<ClientFormData>({
    defaultValues: { name: "", phone: "", email: "", document: "", status: "active", referralSource: "" },
  });

  const filtered = clients?.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    (c.email ?? "").toLowerCase().includes(search.toLowerCase())
  ) ?? [];

  const openCreate = () => {
    setEditingId(null);
    form.reset({ name: "", phone: "", email: "", document: "", status: "active", referralSource: "" });
    setDialogOpen(true);
  };

  const openEdit = (client: typeof filtered[0]) => {
    setEditingId(client.id);
    form.reset({
      name: client.name,
      phone: client.phone ?? "",
      email: client.email ?? "",
      document: client.document ?? "",
      status: (client.status as "active" | "inactive") ?? "active",
      referralSource: client.referralSource && client.referralSource !== "invite_link" ? client.referralSource : "",
    });
    setDialogOpen(true);
  };

  const onSubmit = (data: ClientFormData) => {
    const payload = {
      name: data.name,
      phone: data.phone || undefined,
      email: data.email || undefined,
      document: data.document || undefined,
      status: data.status,
      referralSource: data.referralSource.trim() || undefined,
    };

    if (editingId) {
      updateClient.mutate(
        { id: editingId, data: payload },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListClientsQueryKey() });
            setDialogOpen(false);
            toast({ title: "Cliente atualizado com sucesso" });
          },
          onError: (err: any) => {
            toast({ title: "Erro ao atualizar cliente", description: err?.message ?? "Tente novamente.", variant: "destructive" });
          },
        }
      );
    } else {
      createClient.mutate(
        { data: payload },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListClientsQueryKey() });
            setDialogOpen(false);
            toast({ title: "Cliente adicionado à carteira" });
          },
          onError: (err: any) => {
            toast({ title: "Erro ao criar cliente", description: err?.message ?? "Tente novamente.", variant: "destructive" });
          },
        }
      );
    }
  };

  const confirmDelete = () => {
    if (deleteId === null) return;
    deleteClient.mutate(
      { id: deleteId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListClientsQueryKey() });
          setDeleteId(null);
          toast({ title: "Cliente removido da carteira" });
        },
      }
    );
  };

  const shareInviteViaWhatsapp = (companyId: number) => {
    const link = `${window.location.origin}/invite/${companyId}`;
    const msg = encodeURIComponent(
      `Olá! Acesse o link abaixo para se cadastrar como cliente:\n${link}`
    );
    window.open(`https://wa.me/?text=${msg}`, "_blank");
  };

  const { data: myCompany } = useGetMyCompany();
  const companyId = myCompany?.id ?? clients?.[0]?.companyId;

  const { data: overdueInvoices } = useListInvoices({ status: "overdue" });
  const { data: pendingInvoices } = useListInvoices({ status: "pending" });
  const { data: requestedInvoices } = useListInvoices({ status: "requested" });

  const overdueByClient = (overdueInvoices ?? []).reduce<Record<number, { principal: number; interest: number; lateFees: number }>>((acc, inv) => {
    const cid = inv.clientId;
    if (!acc[cid]) acc[cid] = { principal: 0, interest: 0, lateFees: 0 };
    acc[cid].principal += inv.amount ?? 0;
    acc[cid].interest += ((inv.amount ?? 0) * (inv.interestRate ?? 0)) / 100;
    acc[cid].lateFees += (inv.lateFee ?? 0) * (inv.daysLate ?? 0);
    return acc;
  }, {});

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const in3Days = new Date(todayStart);
  in3Days.setDate(in3Days.getDate() + 3);

  const allActiveinvoices = [...(pendingInvoices ?? []), ...(requestedInvoices ?? [])];
  const dueSoonByClient = allActiveinvoices
    .filter((inv) => {
      if (!inv.dueDate) return false;
      const due = new Date(inv.dueDate);
      due.setHours(0, 0, 0, 0);
      return due >= todayStart && due <= in3Days;
    })
    .reduce<Record<number, typeof allActiveinvoices[0]>>((acc, inv) => {
      const cid = inv.clientId;
      if (!acc[cid] || new Date(inv.dueDate!) < new Date(acc[cid].dueDate!)) {
        acc[cid] = inv;
      }
      return acc;
    }, {});

  const reminderWhatsappUrl = (phone: string | null | undefined, name: string, clientId: number) => {
    if (!phone) return null;
    const inv = dueSoonByClient[clientId];
    if (!inv) return null;
    const digits = phone.replace(/\D/g, "");
    const number = digits.startsWith("55") ? digits : `55${digits}`;
    const principal = inv.amount ?? 0;
    const interest = (principal * (inv.interestRate ?? 0)) / 100;
    const lateFees = 0;
    const total = principal + interest;
    const msg =
      `🔹 Mensagem automática — Lembrete de vencimento (3 dias antes)\n\n` +
      `Olá, ${name}.\n\n` +
      `A Lastro Capital Gestão de Negócio informa que seu pagamento está próximo do vencimento.\n\n` +
      `Segue o resumo do seu contrato:\n\n` +
      `Valor total emprestado: ${formatCurrency(principal)}\n` +
      `Juros previstos: ${formatCurrency(interest)}\n` +
      `Taxas de atraso (se houver): ${formatCurrency(lateFees)}\n` +
      `Valor total para quitação: ${formatCurrency(total)}\n\n` +
      `Este é um aviso antecipado de 3 dias para que você possa se organizar e evitar encargos adicionais.\n\n` +
      `Caso o pagamento já tenha sido realizado, desconsidere esta mensagem.\n\n` +
      `Após a realização do pagamento, solicitamos por gentileza o envio do comprovante para confirmação e atualização do seu contrato.\n\n` +
      `Agradecemos a sua atenção e confiança. Conte conosco para o que precisar.\n\n` +
      `Atenciosamente,\nLastro Capital Gestão de Negócio`;
    return `https://wa.me/${number}?text=${encodeURIComponent(msg)}`;
  };

  const alertWhatsappUrl = (phone: string | null | undefined, name: string, clientId: number) => {
    if (!phone) return null;
    const info = overdueByClient[clientId];
    if (!info) return null;
    const digits = phone.replace(/\D/g, "");
    const number = digits.startsWith("55") ? digits : `55${digits}`;
    const msg =
      `Olá, ${name}.\n\n` +
      `A Lastro Capital Gestão de Negócio informa que identificamos pendências em seu contrato.\n\n` +
      `Valor solicitado: ${formatCurrency(info.principal)}\n` +
      `Juros em atraso: ${formatCurrency(info.interest)}\n` +
      `Taxas de atraso: ${formatCurrency(info.lateFees)}\n\n` +
      `Solicitamos contato imediato com nossa equipe para regularização do valor em aberto.`;
    return `https://wa.me/${number}?text=${encodeURIComponent(msg)}`;
  };

  // KPI counts
  const totalClients = clients?.length ?? 0;
  const activeCount = clients?.filter((c) => c.status === "active").length ?? 0;
  const inactiveCount = clients?.filter((c) => c.status === "inactive").length ?? 0;
  const overdueCount = Object.keys(overdueByClient).length;

  return (
    <AppLayout>
      {/* HEADER */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-7">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-7 h-7 rounded-lg bg-primary/15 border border-primary/25 flex items-center justify-center">
              <Users className="h-3.5 w-3.5 text-primary" />
            </div>
            <h1 className="text-2xl font-bold">Carteira de Clientes</h1>
          </div>
          <p className="text-muted-foreground text-sm">
            Tomadores de crédito, contatos e situação operacional
          </p>
        </div>
        <div className="flex gap-2">
          {companyId && (
            <Button
              variant="outline"
              onClick={() => shareInviteViaWhatsapp(companyId)}
              className="gap-2 border-green-500/40 text-green-600 hover:bg-green-500/10 hover:text-green-600 dark:text-green-400 dark:border-green-500/30"
            >
              <WhatsAppIcon className="h-4 w-4" />
              Convidar via WhatsApp
            </Button>
          )}
          <Button onClick={openCreate} data-testid="button-add-client" className="gap-2">
            <Plus className="h-4 w-4" />
            Novo Cliente
          </Button>
        </div>
      </div>

      {/* KPI CARDS */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-7">
        <Card className="border-border/60">
          <div className="p-4 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
              <Users className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total</p>
              <p className="text-xl font-bold tabular-nums">{isLoading ? "—" : totalClients}</p>
            </div>
          </div>
        </Card>
        <Card className="border-emerald-500/20 bg-emerald-500/5">
          <div className="p-4 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/15 flex items-center justify-center shrink-0">
              <UserCheck className="h-4 w-4 text-emerald-500" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Ativos</p>
              <p className="text-xl font-bold tabular-nums text-emerald-500">{isLoading ? "—" : activeCount}</p>
            </div>
          </div>
        </Card>
        <Card className="border-border/60">
          <div className="p-4 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
              <UserX className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Inativos</p>
              <p className="text-xl font-bold tabular-nums">{isLoading ? "—" : inactiveCount}</p>
            </div>
          </div>
        </Card>
        <Card className={overdueCount > 0 ? "border-destructive/20 bg-destructive/5" : "border-border/60"}>
          <div className="p-4 flex items-center gap-3">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${overdueCount > 0 ? "bg-destructive/15" : "bg-muted"}`}>
              <ShieldAlert className={`h-4 w-4 ${overdueCount > 0 ? "text-destructive" : "text-muted-foreground"}`} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Em atraso</p>
              <p className={`text-xl font-bold tabular-nums ${overdueCount > 0 ? "text-destructive" : ""}`}>{overdueCount}</p>
            </div>
          </div>
        </Card>
      </div>

      {/* BUSCA + FILTRO */}
      <div className="flex gap-3 mb-5">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nome ou e-mail..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            data-testid="input-search-clients"
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="h-3.5 w-3.5 text-muted-foreground hidden sm:block" />
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as any)}>
            <SelectTrigger className="w-36 h-9 text-sm" data-testid="select-status-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              <SelectItem value="active">Ativos</SelectItem>
              <SelectItem value="inactive">Inativos</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* TABELA */}
      {isLoading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Users className="h-10 w-10 text-muted-foreground mb-3 opacity-40" />
            <p className="font-medium text-muted-foreground">Nenhum cliente encontrado</p>
            <p className="text-sm text-muted-foreground/70 mt-1">Adicione tomadores de crédito à sua carteira</p>
            <Button variant="outline" className="mt-5" onClick={openCreate}>
              <Plus className="h-4 w-4 mr-2" />
              Adicionar primeiro cliente
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full min-w-[620px]">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground bg-muted/30">
                  <th className="px-5 py-3 font-medium">Nome</th>
                  <th className="px-5 py-3 font-medium">Indicação</th>
                  <th className="px-5 py-3 font-medium">Telefone</th>
                  <th className="px-5 py-3 font-medium">Documento</th>
                  <th className="px-5 py-3 font-medium">Situação</th>
                  <th className="px-5 py-3 font-medium text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((client) => {
                  const waUrl = whatsappUrl(client.phone, client.name);
                  const alertUrl = alertWhatsappUrl(client.phone, client.name, client.id);
                  const reminderUrl = reminderWhatsappUrl(client.phone, client.name, client.id);
                  const hasOverdue = !!overdueByClient[client.id];

                  return (
                    <tr
                      key={client.id}
                      className="border-b border-border last:border-0 hover:bg-accent/40 transition-colors group"
                      data-testid={`row-client-${client.id}`}
                    >
                      <td className="px-5 py-3.5 font-medium">
                        <div className="flex items-center gap-2">
                          <span>{client.name}</span>
                          {hasOverdue && (
                            <span className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded px-1.5 py-0.5">
                              em atraso
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-sm">
                        {client.referralSource && client.referralSource !== "invite_link" ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 border border-primary/20 text-xs font-medium text-primary">
                            {client.referralSource}
                          </span>
                        ) : client.referralSource === "invite_link" ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted border border-border text-xs text-muted-foreground">
                            link convite
                          </span>
                        ) : (
                          <span className="opacity-40">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-sm text-muted-foreground">
                        {client.phone ?? <span className="opacity-40">—</span>}
                      </td>
                      <td className="px-5 py-3.5 text-sm text-muted-foreground">
                        {client.document ?? <span className="opacity-40">—</span>}
                      </td>
                      <td className="px-5 py-3.5" data-testid={`status-client-${client.id}`}>
                        {client.status === "active" ? (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-emerald-500/10 text-emerald-500 border border-emerald-500/25">
                            <UserCheck className="h-3 w-3" />
                            Ativo
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-muted text-muted-foreground border border-border">
                            <UserX className="h-3 w-3" />
                            Inativo
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center justify-end gap-1">
                          {reminderUrl && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-amber-500 hover:text-amber-600 hover:bg-amber-500/10"
                              title="Lembrete de vencimento via WhatsApp (3 dias)"
                              onClick={() => window.open(reminderUrl, "_blank")}
                              data-testid={`button-reminder-client-${client.id}`}
                            >
                              <Bell className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {alertUrl && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                              title="Alertar sobre atraso via WhatsApp"
                              onClick={() => window.open(alertUrl, "_blank")}
                              data-testid={`button-alert-client-${client.id}`}
                            >
                              <AlertTriangle className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {waUrl && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-emerald-500 hover:text-emerald-600 hover:bg-emerald-500/10"
                              title="Chamar no WhatsApp"
                              onClick={() => window.open(waUrl, "_blank")}
                              data-testid={`button-whatsapp-client-${client.id}`}
                            >
                              <MessageCircle className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={() => openEdit(client)}
                            data-testid={`button-edit-client-${client.id}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={() => setDeleteId(client.id)}
                            data-testid={`button-delete-client-${client.id}`}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* DIALOG — Cadastro / Edição */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? "Editar Cliente" : "Novo Cliente"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div>
              <Label htmlFor="name">Nome completo *</Label>
              <Input id="name" placeholder="Nome do tomador" {...form.register("name", { required: true })} data-testid="input-client-name" />
            </div>
            <div>
              <Label htmlFor="phone">Telefone / WhatsApp</Label>
              <Input id="phone" placeholder="Ex: 11 9 9999-9999" {...form.register("phone")} data-testid="input-client-phone" />
            </div>
            <div>
              <Label htmlFor="email">E-mail</Label>
              <Input id="email" type="email" {...form.register("email")} data-testid="input-client-email" />
            </div>
            <div>
              <Label htmlFor="document">CPF / CNPJ</Label>
              <Input id="document" placeholder="000.000.000-00" {...form.register("document")} data-testid="input-client-document" />
            </div>
            <div>
              <Label htmlFor="referralSource">Indicação</Label>
              <Input
                id="referralSource"
                placeholder="Ex: Lucas, João, Facebook..."
                {...form.register("referralSource")}
                data-testid="input-client-referral"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Use <code>/vencidos&lt;nome&gt;</code> no Telegram para filtrar por indicação
              </p>
            </div>
            <div>
              <Label>Situação</Label>
              <Select value={form.watch("status")} onValueChange={(v) => form.setValue("status", v as any)}>
                <SelectTrigger data-testid="select-client-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Ativo</SelectItem>
                  <SelectItem value="inactive">Inativo</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button>
              <Button type="submit" disabled={createClient.isPending || updateClient.isPending} data-testid="button-submit-client">
                {editingId ? "Salvar alterações" : "Adicionar à carteira"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ALERT — Confirmar exclusão */}
      <AlertDialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover cliente da carteira?</AlertDialogTitle>
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
