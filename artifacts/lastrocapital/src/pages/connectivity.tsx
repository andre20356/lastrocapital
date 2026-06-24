import { useState, useEffect, useCallback, useRef } from "react";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@clerk/react";

interface ConnectivityStatus {
  whatsapp: {
    status: "connected" | "disconnected" | "connecting";
    phone: string | null;
    profileName: string | null;
    instance: string | null;
  };
  telegram: {
    status: "connected" | "disconnected";
    botUsername: string | null;
    chatId: string | null;
  };
}

export default function ConnectivityPage() {
  const { toast } = useToast();
  const { getToken } = useAuth();

  // WhatsApp state
  const [waStatus, setWaStatus] = useState<"connected" | "disconnected" | "connecting">("disconnected");
  const [waPhone, setWaPhone] = useState<string | null>(null);
  const [waProfileName, setWaProfileName] = useState<string | null>(null);
  const [waInstance, setWaInstance] = useState<string | null>(null);
  const [waQrcode, setWaQrcode] = useState<string | null>(null);
  const [waLoading, setWaLoading] = useState(false);
  const [waDisconnecting, setWaDisconnecting] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Telegram state
  const [tgToken, setTgToken] = useState("");
  const [tgChatId, setTgChatId] = useState("");
  const [tgStatus, setTgStatus] = useState<"connected" | "disconnected">("disconnected");
  const [tgBotUsername, setTgBotUsername] = useState<string | null>(null);
  const [tgSaving, setTgSaving] = useState(false);
  const [tgTesting, setTgTesting] = useState(false);

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

  // Load initial status
  useEffect(() => {
    authFetch("/api/connectivity")
      .then((d: any) => {
        setWaStatus(d.whatsapp.status);
        setWaPhone(d.whatsapp.phone);
        setWaProfileName(d.whatsapp.profileName);
        setWaInstance(d.whatsapp.instance);
        setTgStatus(d.telegram.status);
        setTgBotUsername(d.telegram.botUsername);
        setTgChatId(d.telegram.chatId ?? "");
      })
      .catch(() => {});

    authFetch("/api/companies/telegram")
      .then((d: any) => {
        setTgToken(d.telegramBotToken ?? "");
        setTgChatId(d.telegramChatId ?? "");
      })
      .catch(() => {});
  }, [authFetch]);

  // Poll WA status when connecting
  useEffect(() => {
    if (waStatus === "connecting") {
      pollingRef.current = setInterval(async () => {
        try {
          const d = await authFetch("/api/connectivity/whatsapp/status") as any;
          if (d.status === "connected") {
            setWaStatus("connected");
            setWaPhone(d.phone);
            setWaProfileName(d.profileName);
            setWaQrcode(null);
            if (pollingRef.current) clearInterval(pollingRef.current);
            toast({ title: "WhatsApp conectado!", description: d.profileName ?? d.phone ?? "Conexão estabelecida." });
          } else if (d.status === "disconnected") {
            setWaStatus("disconnected");
            setWaQrcode(null);
            if (pollingRef.current) clearInterval(pollingRef.current);
          } else {
            // Still connecting — refresh QR
            const qrData = await authFetch("/api/connectivity/whatsapp/qr") as any;
            if (qrData.qrcode) setWaQrcode(qrData.qrcode);
          }
        } catch {
          // ignore polling errors
        }
      }, 3000);
    } else {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    }
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [waStatus, authFetch, toast]);

  const handleWaConnect = async () => {
    setWaLoading(true);
    try {
      const d = await authFetch("/api/connectivity/whatsapp/connect", { method: "POST" }) as any;
      setWaInstance(d.instance);
      setWaStatus("connecting");
      if (d.qrcode) setWaQrcode(d.qrcode);
      toast({ title: "Escaneie o QR code", description: "Abra o WhatsApp e escaneie o código." });
    } catch (e: any) {
      toast({ title: "Erro ao conectar", description: e?.message, variant: "destructive" });
    } finally {
      setWaLoading(false);
    }
  };

  const handleWaDisconnect = async () => {
    setWaDisconnecting(true);
    try {
      await authFetch("/api/connectivity/whatsapp", { method: "DELETE" });
      setWaStatus("disconnected");
      setWaPhone(null);
      setWaProfileName(null);
      setWaInstance(null);
      setWaQrcode(null);
      toast({ title: "WhatsApp desconectado." });
    } catch (e: any) {
      toast({ title: "Erro ao desconectar", description: e?.message, variant: "destructive" });
    } finally {
      setWaDisconnecting(false);
    }
  };

  const handleTgSave = async () => {
    setTgSaving(true);
    try {
      await authFetch("/api/companies/telegram", {
        method: "PUT",
        body: JSON.stringify({ telegramBotToken: tgToken, telegramChatId: tgChatId }),
      });
      toast({ title: "Telegram salvo!", description: "Configurações atualizadas." });
      // Refresh status
      const d = await authFetch("/api/connectivity") as any;
      setTgStatus(d.telegram.status);
      setTgBotUsername(d.telegram.botUsername);
    } catch {
      toast({ title: "Erro ao salvar Telegram", variant: "destructive" });
    } finally {
      setTgSaving(false);
    }
  };

  const handleTgTest = async () => {
    setTgTesting(true);
    try {
      await authFetch("/api/companies/telegram/test", {
        method: "POST",
        body: JSON.stringify({ telegramBotToken: tgToken, telegramChatId: tgChatId }),
      });
      toast({ title: "Mensagem enviada!", description: "Verifique seu Telegram." });
    } catch (e: any) {
      toast({ title: "Erro no teste", description: e?.message ?? "Token ou Chat ID inválido.", variant: "destructive" });
    } finally {
      setTgTesting(false);
    }
  };

  const handleFetchChatId = async () => {
    try {
      const d = await authFetch("/api/companies/telegram/fetch-chat-id", {
        method: "POST",
        body: JSON.stringify({ telegramBotToken: tgToken }),
      }) as any;
      setTgChatId(d.chatId);
      toast({ title: "Chat ID encontrado!", description: `ID: ${d.chatId}` });
    } catch (e: any) {
      toast({ title: "Erro ao buscar Chat ID", description: e?.message ?? "Verifique o token.", variant: "destructive" });
    }
  };

  const statusBadge = (status: string) => {
    if (status === "connected") return <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200">Conectado</Badge>;
    if (status === "connecting") return <Badge className="bg-amber-100 text-amber-700 border-amber-200">Conectando...</Badge>;
    return <Badge variant="outline" className="text-muted-foreground">Desconectado</Badge>;
  };

  return (
    <AppLayout>
      <div className="max-w-2xl mx-auto py-8 px-4 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Conectividade</h1>
          <p className="text-sm text-muted-foreground mt-1">Gerencie as integrações de WhatsApp e Telegram da sua empresa.</p>
        </div>

        {/* WhatsApp Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <span className="text-xl">📱</span> WhatsApp
              </CardTitle>
              {statusBadge(waStatus)}
            </div>
            <CardDescription>
              Conecte o WhatsApp da sua empresa para atendimento automatizado de clientes.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {waStatus === "connected" && (
              <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-4 space-y-1 dark:bg-emerald-950/20 dark:border-emerald-900">
                {waProfileName && (
                  <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300">{waProfileName}</p>
                )}
                {waPhone && (
                  <p className="text-xs text-emerald-600 dark:text-emerald-400 font-mono">
                    {waPhone.replace("@s.whatsapp.net", "").replace("@c.us", "")}
                  </p>
                )}
                {waInstance && (
                  <p className="text-xs text-muted-foreground">Instância: {waInstance}</p>
                )}
              </div>
            )}

            {waStatus === "connecting" && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Escaneie o QR code abaixo com o WhatsApp do número que deseja conectar:
                </p>
                {waQrcode ? (
                  <div className="flex justify-center">
                    <img
                      src={waQrcode.startsWith("data:") ? waQrcode : `data:image/png;base64,${waQrcode}`}
                      alt="QR Code WhatsApp"
                      className="w-56 h-56 rounded-lg border"
                    />
                  </div>
                ) : (
                  <div className="flex justify-center items-center w-56 h-56 mx-auto rounded-lg border bg-muted/30">
                    <span className="text-sm text-muted-foreground">Aguardando QR code...</span>
                  </div>
                )}
                <p className="text-xs text-center text-muted-foreground">
                  O QR code é atualizado automaticamente. Aguarde após escanear.
                </p>
              </div>
            )}

            {waStatus === "disconnected" && (
              <p className="text-sm text-muted-foreground">
                Clique em conectar para gerar um QR code e vincular o WhatsApp da sua empresa.
              </p>
            )}

            <div className="flex gap-2 pt-1">
              {waStatus === "disconnected" && (
                <Button onClick={handleWaConnect} disabled={waLoading} className="flex-1">
                  {waLoading ? "Conectando..." : "Conectar WhatsApp"}
                </Button>
              )}
              {waStatus === "connecting" && (
                <>
                  <Button variant="outline" onClick={handleWaDisconnect} disabled={waDisconnecting} className="flex-1">
                    Cancelar
                  </Button>
                </>
              )}
              {waStatus === "connected" && (
                <Button variant="destructive" onClick={handleWaDisconnect} disabled={waDisconnecting} className="flex-1">
                  {waDisconnecting ? "Desconectando..." : "Desconectar"}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Telegram Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <span className="text-xl">🤖</span> Telegram
              </CardTitle>
              {statusBadge(tgStatus)}
            </div>
            <CardDescription>
              Configure o bot do Telegram para notificações e atendimento da sua empresa.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {tgStatus === "connected" && tgBotUsername && (
              <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 dark:bg-blue-950/20 dark:border-blue-900">
                <p className="text-sm text-blue-800 dark:text-blue-300 font-medium">@{tgBotUsername}</p>
                <a
                  href={`https://t.me/${tgBotUsername}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                >
                  https://t.me/{tgBotUsername}
                </a>
              </div>
            )}

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
              <Label htmlFor="tgToken">Token do Bot</Label>
              <Input
                id="tgToken"
                placeholder="1234567890:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                value={tgToken}
                onChange={(e) => setTgToken(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="tgChatId">Chat ID</Label>
              <div className="flex gap-2">
                <Input
                  id="tgChatId"
                  placeholder="Ex: 6518971459"
                  value={tgChatId}
                  onChange={(e) => setTgChatId(e.target.value)}
                />
                <Button
                  variant="outline"
                  className="shrink-0"
                  disabled={!tgToken}
                  onClick={handleFetchChatId}
                >
                  Buscar Chat ID
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Envie qualquer mensagem pro seu bot e clique em "Buscar Chat ID"
              </p>
            </div>

            <div className="flex gap-3 pt-2">
              <Button onClick={handleTgSave} disabled={tgSaving} className="flex-1">
                {tgSaving ? "Salvando..." : "Salvar"}
              </Button>
              <Button onClick={handleTgTest} disabled={tgTesting || !tgToken || !tgChatId} variant="outline">
                {tgTesting ? "Enviando..." : "Testar"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
