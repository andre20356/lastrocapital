import { useState } from "react";
import { useListClients, getListClientsQueryKey, useCreateClient, useUpdateClient, useDeleteClient, useGetMyCompany, useListInvoices } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useForm } from "react-hook-form";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Pencil, Trash2, Search, Users, MessageCircle, Link, AlertTriangle, Bell } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/format";

interface ClientFormData {
  name: string;
  phone: string;
  email: string;
  document: string;
  status: "active" | "inactive";
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
    defaultValues: { name: "", phone: "", email: "", document: "", status: "active" },
  });

  const filtered = clients?.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    (c.email ?? "").toLowerCase().includes(search.toLowerCase())
  ) ?? [];

  const openCreate = () => {
    setEditingId(null);
    form.reset({ name: "", phone: "", email: "", document: "", status: "active" });
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
        }
      );
    } else {
      createClient.mutate(
        { data: payload },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListClientsQueryKey() });
            setDialogOpen(false);
            toast({ title: "Cliente criado com sucesso" });
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
          toast({ title: "Cliente removido" });
        },
      }
    );
  };

  const copyInviteLink = (companyId: number) => {
    const link = `${window.location.origin}/invite/${companyId}`;
    navigator.clipboard.writeText(link).then(() => {
      toast({ title: "Link de convite copiado!" });
    });
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

  // Find invoices due in the next 3 days (pending or requested, not yet overdue)
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
      // keep the earliest due date per client
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
    const lateFees = 0; // not overdue yet
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

  return (
    <AppLayout>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">Clientes</h1>
          <p className="text-muted-foreground mt-1">Gerencie sua base de clientes</p>
        </div>
        <div className="flex gap-2">
          {companyId && (
            <Button variant="outline" onClick={() => copyInviteLink(companyId)}>
              <Link className="h-4 w-4 mr-2" />
              Link de Convite
            </Button>
          )}
          <Button onClick={openCreate} data-testid="button-add-client">
            <Plus className="h-4 w-4 mr-2" />
            Novo Cliente
          </Button>
        </div>
      </div>

      <div className="flex gap-4 mb-6">
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
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as any)}>
          <SelectTrigger className="w-40" data-testid="select-status-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            <SelectItem value="active">Ativos</SelectItem>
            <SelectItem value="inactive">Inativos</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Users className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">Nenhum cliente encontrado</p>
            <Button variant="outline" className="mt-4" onClick={openCreate}>Adicionar primeiro cliente</Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border text-left text-sm text-muted-foreground">
                  <th className="px-6 py-4 font-medium">Nome</th>
                  <th className="px-6 py-4 font-medium">Telefone</th>
                  <th className="px-6 py-4 font-medium">E-mail</th>
                  <th className="px-6 py-4 font-medium">Documento</th>
                  <th className="px-6 py-4 font-medium">Status</th>
                  <th className="px-6 py-4 font-medium text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((client) => {
                  const waUrl = whatsappUrl(client.phone, client.name);
                  const alertUrl = alertWhatsappUrl(client.phone, client.name, client.id);
                  const reminderUrl = reminderWhatsappUrl(client.phone, client.name, client.id);
                  return (
                    <tr key={client.id} className="border-b border-border last:border-0 hover:bg-accent/30 transition-colors" data-testid={`row-client-${client.id}`}>
                      <td className="px-6 py-4 font-medium">
                        {client.name}
                        {client.referralSource === "invite_link" && (
                          <span className="ml-2 text-xs text-primary bg-primary/10 rounded px-1 py-0.5">convite</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-muted-foreground">{client.phone ?? "-"}</td>
                      <td className="px-6 py-4 text-muted-foreground">{client.email ?? "-"}</td>
                      <td className="px-6 py-4 text-muted-foreground">{client.document ?? "-"}</td>
                      <td className="px-6 py-4">
                        <Badge variant={client.status === "active" ? "default" : "secondary"} data-testid={`status-client-${client.id}`}>
                          {client.status === "active" ? "Ativo" : "Inativo"}
                        </Badge>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center justify-end gap-2">
                          {reminderUrl && (
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Enviar lembrete de vencimento (3 dias) via WhatsApp"
                              onClick={() => window.open(reminderUrl, "_blank")}
                              className="text-amber-500 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950/30"
                              data-testid={`button-reminder-client-${client.id}`}
                            >
                              <Bell className="h-4 w-4" />
                            </Button>
                          )}
                          {alertUrl && (
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Alertar cliente sobre atraso via WhatsApp"
                              onClick={() => window.open(alertUrl, "_blank")}
                              className="text-destructive hover:text-destructive hover:bg-destructive/10"
                              data-testid={`button-alert-client-${client.id}`}
                            >
                              <AlertTriangle className="h-4 w-4" />
                            </Button>
                          )}
                          {waUrl && (
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Chamar no WhatsApp"
                              onClick={() => window.open(waUrl, "_blank")}
                              data-testid={`button-whatsapp-client-${client.id}`}
                            >
                              <MessageCircle className="h-4 w-4 text-emerald-500" />
                            </Button>
                          )}
                          <Button variant="ghost" size="icon" onClick={() => openEdit(client)} data-testid={`button-edit-client-${client.id}`}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => setDeleteId(client.id)} data-testid={`button-delete-client-${client.id}`}>
                            <Trash2 className="h-4 w-4 text-destructive" />
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

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? "Editar Cliente" : "Novo Cliente"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div>
              <Label htmlFor="name">Nome *</Label>
              <Input id="name" {...form.register("name", { required: true })} data-testid="input-client-name" />
            </div>
            <div>
              <Label htmlFor="phone">Telefone</Label>
              <Input id="phone" {...form.register("phone")} data-testid="input-client-phone" />
            </div>
            <div>
              <Label htmlFor="email">E-mail</Label>
              <Input id="email" type="email" {...form.register("email")} data-testid="input-client-email" />
            </div>
            <div>
              <Label htmlFor="document">CPF/CNPJ</Label>
              <Input id="document" {...form.register("document")} data-testid="input-client-document" />
            </div>
            <div>
              <Label>Status</Label>
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
                {editingId ? "Salvar" : "Criar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover cliente?</AlertDialogTitle>
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
