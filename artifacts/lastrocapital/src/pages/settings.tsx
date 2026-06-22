import { useState, useEffect, useCallback } from "react";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@clerk/react";

export default function Settings() {
  const { toast } = useToast();
  const { getToken } = useAuth();
  const [token,  setToken]  = useState("");
  const [chatId, setChatId] = useState("");
  const [saving,  setSaving]  = useState(false);
  const [testing, setTesting] = useState(false);
  const [botLink, setBotLink] = useState<{ username: string; link: string; name: string } | null>(null);
  const [pixKey,           setPixKey]           = useState("");
  const [pixRecipientName, setPixRecipientName] = useState("");
  const [pixBankName,      setPixBankName]      = useState("");
  const [savingPix,        setSavingPix]        = useState(false);

  function detectPixKeyType(key: string): { type: string; label: string } | null {
    const k = key.trim();
    if (!k) return null;
    if (k.startsWith("+"))  return { type: "telefone",  label: "Telefone" };
    if (k.includes("@"))    return { type: "email",     label: "E-mail" };
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k))
                            return { type: "aleatoria", label: "Chave Aleatória" };
    const digits = k.replace(/\D/g, "");
    if (digits.length === 11) return { type: "cpf",   label: "CPF" };
    if (digits.length === 14) return { type: "cnpj",  label: "CNPJ" };
    return { type: "aleatoria", label: "Chave Aleatória" };
  }

  const detectedType = detectPixKeyType(pixKey);

  const authFetch = useCallback(async (url: string, opts: RequestInit = {}) => {
    const jwt = await getToken();
    const headers = new Headers(opts.headers);
    if (jwt) headers.set("Authorization", `Bearer ${jwt}`);
    if (opts.body) headers.set("Content-Type", "application/json");
    const res = await fetch(url, { ...opts, headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as any).error ?? `HTTP ${res.status}`);
    }
    return res.status === 204 ? null : res.json();
  }, [getToken]);

  useEffect(() => {
    authFetch("/api/companies/telegram")
      .then((d: any) => {
        setToken(d.telegramBotToken ?? "");
        setChatId(d.telegramChatId ?? "");
      })
      .catch(() => {});
    authFetch("/api/companies/telegram/bot-info")
      .then((d: any) => setBotLink(d))
      .catch(() => {});
    authFetch("/api/companies/pix")
      .then((d: any) => {
        setPixKey(d.pixKey ?? "");
        setPixRecipientName(d.pixRecipientName ?? "");
        setPixBankName(d.pixBankName ?? "");
      })
      .catch(() => {});
  }, [authFetch]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await authFetch("/api/companies/telegram", {
        method: "PUT",
        body: JSON.stringify({ telegramBotToken: token, telegramChatId: chatId }),
      });
      toast({ title: "Configurações salvas!", description: "Notificações do Telegram atualizadas." });
      authFetch("/api/companies/telegram/bot-info").then((d: any) => setBotLink(d)).catch(() => {});
    } catch {
      toast({ title: "Erro ao salvar", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      await authFetch("/api/companies/telegram/test", {
        method: "POST",
        body: JSON.stringify({ telegramBotToken: token, telegramChatId: chatId }),
      });
      toast({ title: "Mensagem enviada!", description: "Verifique seu Telegram." });
    } catch (e: any) {
      toast({ title: "Erro no teste", description: e?.message ?? "Token ou Chat ID inválido.", variant: "destructive" });
    } finally {
      setTesting(false);
    }
  };

  const handleSavePix = async () => {
    setSavingPix(true);
    try {
      await authFetch("/api/companies/pix", {
        method: "PUT",
        body: JSON.stringify({ pixKey, pixRecipientName, pixBankName }),
      });
      toast({ title: "Chave PIX salva!", description: "Clientes poderão ver a chave no bot." });
    } catch {
      toast({ title: "Erro ao salvar PIX", variant: "destructive" });
    } finally {
      setSavingPix(false);
    }
  };

  return (
    <AppLayout>
      <div className="max-w-xl mx-auto py-8 px-4 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Configurações</h1>
          <p className="text-sm text-muted-foreground mt-1">Gerencie as integrações da sua conta.</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span>🤖</span> Notificações por Telegram
            </CardTitle>
            <CardDescription>
              Receba alertas de vencimento de cobranças diretamente no seu Telegram, todos os dias às 8h.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">

            <div className="rounded-lg bg-muted/50 border p-4 text-sm text-muted-foreground space-y-1">
              <p className="font-medium text-foreground">Como configurar:</p>
              <ol className="list-decimal list-inside space-y-1">
                <li>Crie um bot em <b>@BotFather</b> no Telegram e copie o token</li>
                <li>Envie qualquer mensagem para o bot criado</li>
                <li>Cole o token abaixo e clique em <b>Buscar Chat ID</b></li>
                <li>Salve e teste a conexão</li>
              </ol>
            </div>

            <div className="space-y-2">
              <Label htmlFor="token">Token do Bot</Label>
              <Input
                id="token"
                placeholder="1234567890:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="chatId">Chat ID</Label>
              <div className="flex gap-2">
                <Input
                  id="chatId"
                  placeholder="Ex: 6518971459"
                  value={chatId}
                  onChange={(e) => setChatId(e.target.value)}
                />
                <Button
                  variant="outline"
                  className="shrink-0"
                  disabled={!token}
                  onClick={async () => {
                    try {
                      const d = await authFetch("/api/companies/telegram/fetch-chat-id", {
                        method: "POST",
                        body: JSON.stringify({ telegramBotToken: token }),
                      });
                      setChatId((d as any).chatId);
                      toast({ title: "Chat ID encontrado!", description: `ID: ${(d as any).chatId}` });
                    } catch (e: any) {
                      toast({ title: "Erro ao buscar Chat ID", description: e?.message ?? "Verifique o token.", variant: "destructive" });
                    }
                  }}
                >
                  Buscar Chat ID
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Envie qualquer mensagem pro seu bot e clique em "Buscar Chat ID"</p>
            </div>

            <div className="flex gap-3 pt-2">
              <Button onClick={handleSave} disabled={saving} className="flex-1">
                {saving ? "Salvando..." : "Salvar"}
              </Button>
              <Button onClick={handleTest} disabled={testing || !token || !chatId} variant="outline">
                {testing ? "Enviando..." : "Testar"}
              </Button>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span>💳</span> Chave PIX
            </CardTitle>
            <CardDescription>
              Configure a chave PIX da empresa. Os clientes poderão solicitá-la via bot com o comando <code>/pagar</code>.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Nome do Recebedor</Label>
              <Input
                placeholder="Ex: João da Silva"
                value={pixRecipientName}
                onChange={(e) => setPixRecipientName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Banco</Label>
              <Input
                placeholder="Ex: Nubank, Itaú, Bradesco..."
                value={pixBankName}
                onChange={(e) => setPixBankName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Chave PIX</Label>
              <Input
                placeholder="CPF, CNPJ, e-mail, telefone (+55...) ou chave aleatória"
                value={pixKey}
                onChange={(e) => setPixKey(e.target.value)}
              />
              {pixKey && (
                <p className="text-xs text-muted-foreground">
                  Tipo detectado:{" "}
                  <span className="font-medium text-foreground">
                    {detectedType?.label ?? "—"}
                  </span>
                </p>
              )}
            </div>
            <Button onClick={handleSavePix} disabled={savingPix || !pixKey}>
              {savingPix ? "Salvando..." : "Salvar PIX"}
            </Button>
          </CardContent>
        </Card>

        {botLink && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <span>🔗</span> Link para Clientes
              </CardTitle>
              <CardDescription>
                Compartilhe este link com seus clientes para que eles vinculem o Telegram e recebam alertas de vencimento.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2">
                <span className="flex-1 text-sm font-mono truncate">{botLink.link}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard.writeText(botLink.link);
                    toast({ title: "Link copiado!" });
                  }}
                >
                  Copiar
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Bot: <b>@{botLink.username}</b> ({botLink.name}) — o cliente abre o link, manda <code>/vincular telefone</code> e pronto.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </AppLayout>
  );
}
