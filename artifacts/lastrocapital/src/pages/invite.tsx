import { useState, useRef } from "react";
import { useParams } from "wouter";
import { useGetInviteInfo, usePublicCreateClient } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useForm } from "react-hook-form";
import { CheckCircle, ShieldCheck, Upload, FileImage } from "lucide-react";

interface FormData {
  name: string;
  phone: string;
  email: string;
  document: string;
  address: string;
  requestedAmount: string;
}

function FileUploadField({
  label,
  id,
  accept,
}: {
  label: string;
  id: string;
  accept: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const handleChange = () => {
    const file = inputRef.current?.files?.[0];
    setFileName(file ? file.name : null);
  };

  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <div
        className="mt-1 border-2 border-dashed border-border rounded-lg p-4 flex flex-col items-center justify-center gap-2 cursor-pointer hover:border-primary/60 hover:bg-accent/40 transition-colors"
        onClick={() => inputRef.current?.click()}
      >
        {fileName ? (
          <>
            <FileImage className="h-6 w-6 text-primary" />
            <p className="text-sm text-foreground font-medium truncate max-w-full">{fileName}</p>
            <p className="text-xs text-muted-foreground">Clique para trocar</p>
          </>
        ) : (
          <>
            <Upload className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Clique para enviar</p>
            <p className="text-xs text-muted-foreground">JPG, PNG ou PDF</p>
          </>
        )}
        <input
          ref={inputRef}
          id={id}
          type="file"
          accept={accept}
          className="hidden"
          onChange={handleChange}
        />
      </div>
    </div>
  );
}

export default function InvitePage() {
  const params = useParams<{ companyId: string }>();
  const companyId = parseInt(params.companyId ?? "0");
  const [submitted, setSubmitted] = useState(false);

  const { data: invite, isLoading, error } = useGetInviteInfo(companyId, {
    query: { queryKey: [companyId], enabled: !!companyId && !isNaN(companyId) },
  });

  const publicCreate = usePublicCreateClient();

  const form = useForm<FormData>({
    defaultValues: { name: "", phone: "", email: "", document: "", address: "", requestedAmount: "" },
  });

  const onSubmit = (data: FormData) => {
    publicCreate.mutate(
      {
        data: {
          companyId,
          name: data.name,
          phone: data.phone || undefined,
          email: data.email || undefined,
        },
      },
      {
        onSuccess: () => setSubmitted(true),
      }
    );
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Carregando...</div>
      </div>
    );
  }

  if (error || !invite) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <Card className="w-full max-w-md">
          <CardContent className="flex flex-col items-center py-12 text-center">
            <p className="text-muted-foreground">Link de convite inválido ou expirado.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4 gap-6">
        <div className="flex items-center gap-2.5">
          <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center">
            <ShieldCheck className="h-5 w-5 text-primary-foreground" />
          </div>
          <span className="text-2xl font-bold tracking-tight text-foreground">LastroCapital</span>
        </div>
        <Card className="w-full max-w-md">
          <CardContent className="flex flex-col items-center py-12 text-center gap-4">
            <CheckCircle className="h-16 w-16 text-emerald-500" />
            <h2 className="text-2xl font-bold">Cadastro realizado!</h2>
            <p className="text-muted-foreground">
              Você foi cadastrado como cliente de <strong>{invite.companyName}</strong>. Em breve entrarão em contato.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center space-y-3">
          <div className="flex items-center justify-center gap-2.5 mb-2">
            <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center">
              <ShieldCheck className="h-5 w-5 text-primary-foreground" />
            </div>
            <span className="text-2xl font-bold tracking-tight text-foreground">LastroCapital</span>
          </div>
          <p className="text-muted-foreground">Preencha seus dados para se cadastrar como cliente</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Seus dados</CardTitle>
            <CardDescription>Todas as informações são mantidas com segurança.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div>
                <Label htmlFor="name">Nome completo *</Label>
                <Input
                  id="name"
                  placeholder="Seu nome completo"
                  {...form.register("name", { required: true })}
                />
                {form.formState.errors.name && (
                  <p className="text-xs text-destructive mt-1">Nome é obrigatório.</p>
                )}
              </div>

              <div>
                <Label htmlFor="document">CPF</Label>
                <Input
                  id="document"
                  placeholder="000.000.000-00"
                  {...form.register("document")}
                />
              </div>

              <div>
                <Label htmlFor="phone">Telefone / WhatsApp</Label>
                <Input
                  id="phone"
                  placeholder="(11) 99999-9999"
                  {...form.register("phone")}
                />
              </div>

              <div>
                <Label htmlFor="email">E-mail</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="seu@email.com"
                  {...form.register("email")}
                />
              </div>

              <div>
                <Label htmlFor="address">Endereço</Label>
                <Input
                  id="address"
                  placeholder="Rua, número, bairro, cidade – UF"
                  {...form.register("address")}
                />
              </div>

              <div>
                <Label htmlFor="requestedAmount">Valor solicitado (R$)</Label>
                <Input
                  id="requestedAmount"
                  placeholder="Ex: 5.000,00"
                  {...form.register("requestedAmount")}
                />
              </div>

              <FileUploadField
                id="doc-photo"
                label="Foto do documento (RG ou CNH)"
                accept="image/*,.pdf"
              />

              <FileUploadField
                id="address-proof"
                label="Foto do comprovante de endereço"
                accept="image/*,.pdf"
              />

              <Button
                type="submit"
                className="w-full"
                disabled={publicCreate.isPending}
              >
                {publicCreate.isPending ? "Cadastrando..." : "Cadastrar"}
              </Button>

              {publicCreate.isError && (
                <p className="text-sm text-destructive text-center">
                  Erro ao cadastrar. Tente novamente.
                </p>
              )}
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
