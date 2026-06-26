import { useState, useEffect, useCallback, useRef } from "react";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@clerk/react";

type WaStatus = "connected" | "disconnected" | "connecting";
type ConnectMode = "idle" | "qr" | "pairing";

export default function ConnectivityPage() {
  const { toast } = useToast();
  const { getToken } = useAuth();

  // WhatsApp state
  const [waStatus, setWaStatus] = useState<WaStatus>("disconnected");
  const [waPhone, setWaPhone] = useState<string | null>(null);
  const [waProfileName, setWaProfileName] = useState<string | null>(null);
  const [waInstance, setWaInstance] = useState<string | null>(null);
  const [waLoading, setWaLoading] = useState(false);
  const [waDisconnecting, setWaDisconnecting] = useState(false);

  // QR code state
  const [waQrcode, setWaQrcode] = useState<string | null>(null);
  const [qrCountdown, setQrCountdown] = useState(30);

  // Pairing code state
  const [connectMode, setConnectMode] = useState<ConnectMode>("idle");
  const [phoneInput, setPhoneInput] = useState("");
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingLoading, setPairingLoading] = useState(false);
  const [pairingCountdown, setPairingCountdown] = useState(40);

  // Telegram state
  const [tgToken, setTgToken] = useState("");
  const [tgChatId, setTgChatId] = useState("");
  const [tgStatus, setTgStatus] = useState<"connected" | "disconnected">("disconnected");
  const [tgBotUsername, setTgBotUsername] = useState<string | null>(null);
  const [tgSaving, setTgSaving] = useState(false);
  const [tgTesting, setTgTesting] = useState(false);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qrTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pairingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // Poll connection status when connecting (QR or pairing)
  useEffect(() => {
    if (waStatus !== "connecting") {
      if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
      return;
    }

    pollingRef.current = setInterval(async () => {
      try {
        const d = await authFetch("/api/connectivity/whatsapp/status") as any;
        if (d.status === "connected") {
          setWaStatus("connected");
          setWaPhone(d.phone);
          setWaProfileName(d.profileName);
          setWaQrcode(null);
          setPairingCode(null);
          setConnectMode("idle");
          if (pollingRef.current) clearInterval(pollingRef.current);
          toast({ title: "WhatsApp conectado!", description: d.profileName ?? d.phone ?? "Conexão estabelecida." });
        } else if (d.status === "disconnected") {
          setWaStatus("disconnected");
          setWaQrcode(null);
          setPairingCode(null);
          setConnectMode("idle");
          if (pollingRef.current) clearInterval(pollingRef.current);
        } else if (connectMode === "qr") {
          // Só atualiza QR no modo QR — não interfere no modo pairing
          const qrData = await authFetch("/api/connectivity/whatsapp/qr") as any;
          if (qrData.qrcode) setWaQrcode(qrData.qrcode);
        }
      } catch {
        // ignore polling errors
      }
    }, 4000);

    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, [waStatus, connectMode, authFetch, toast]);

  // Countdown + auto-refresh do QR code (30s)
  const doQrRefreshRef = useRef(async () => {});
  doQrRefreshRef.current = async () => {
    try {
      const qrData = await authFetch("/api/connectivity/whatsapp/qr") as any;
      if (qrData.qrcode) { setWaQrcode(qrData.qrcode); setQrCountdown(30); }
    } catch {}
  };

  useEffect(() => {
    if (connectMode !== "qr" || !waQrcode) {
      if (qrTimerRef.current) clearInterval(qrTimerRef.current);
      setQrCountdown(30);
      return;
    }
    setQrCountdown(30);
    qrTimerRef.current = setInterval(() => {
      setQrCountdown(prev => {
        if (prev <= 1) { doQrRefreshRef.current(); return 30; }
        return prev - 1;
      });
    }, 1000);
    return () => { if (qrTimerRef.current) clearInterval(qrTimerRef.current); };
  }, [connectMode, !!waQrcode]);

  // Countdown + auto-refresh do pairing code (40s)
  const doPairingRefreshRef = useRef(async () => {});
  doPairingRefreshRef.current = async () => {
    try {
      const d = await authFetch("/api/connectivity/whatsapp/pairing-code") as any;
      if (d.code) { setPairingCode(d.code); setPairingCountdown(40); }
    } catch {}
  };

  useEffect(() => {
    if (connectMode !== "pairing" || !pairingCode) {
      if (pairingTimerRef.current) clearInterval(pairingTimerRef.current);
      setPairingCountdown(40);
      return;
    }
    setPairingCountdown(40);
    pairingTimerRef.current = setInterval(() => {
      setPairingCountdown(prev => {
        if (prev <= 1) { doPairingRefreshRef.current(); return 40; }
        return prev - 1;
      });
    }, 1000);
    return () => { if (pairingTimerRef.current) clearInterval(pairingTimerRef.current); };
  }, [connectMode, !!pairingCode]);

  // Conectar via QR code
  const handleWaConnect = async () => {
    setWaLoading(true);
    try {
      const d = await authFetch("/api/connectivity/whatsapp/connect", { method: "POST" }) as any;
      setWaInstance(d.instance);
      setWaStatus("connecting");
      setConnectMode("qr");
      if (d.qrcode) setWaQrcode(d.qrcode);
      toast({ title: "Escaneie o QR code", description: "Abra o WhatsApp e escaneie o código." });
    } catch (e: any) {
      toast({ title: "Erro ao conectar", description: e?.message, variant: "destructive" });
    } finally {
      setWaLoading(false);
    }
  };

  // Conectar via código de pareamento
  const handleWaPairingCode = async () => {
    if (!phoneInput.trim()) return;
    setPairingLoading(true);
    try {
      const d = await authFetch("/api/connectivity/whatsapp/pairing-code", {
        method: "POST",
        body: JSON.stringify({ phoneNumber: phoneInput }),
      }) as any;
      setPairingCode(d.code);
      setWaStatus("connecting");
      toast({ title: "Código gerado!", description: "Digite-o no WhatsApp em até 40 segundos." });
    } catch (e: any) {
      toast({ title: "Erro ao gerar código", description: e?.message, variant: "destructive" });
    } finally {
      setPairingLoading(false);
    }
  };

  // Refresh manual do pairing code
  const handleRefreshCode = async () => {
    try {
      const d = await authFetch("/api/connectivity/whatsapp/pairing-code") as any;
      if (d.code) { setPairingCode(d.code); setPairingCountdown(40); }
    } catch (e: any) {
      toast({ title: "Erro ao atualizar código", description: e?.message, variant: "destructive" });
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
      setPairingCode(null);
      setConnectMode("idle");
      setPhoneInput("");
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

            {/* Conectado */}
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

            {/* Desconectado — escolha do modo */}
            {waStatus === "disconnected" && connectMode === "idle" && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Escolha como deseja conectar o WhatsApp da sua empresa:
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => { setConnectMode("qr"); handleWaConnect(); }}
                    disabled={waLoading}
                    className="flex flex-col items-center gap-2 p-4 rounded-xl border border-border hover:border-primary/50 hover:bg-primary/5 transition-all text-left disabled:opacity-50"
                  >
                    <span className="text-2xl">📷</span>
                    <div>
                      <p className="text-sm font-medium">QR Code</p>
                      <p className="text-xs text-muted-foreground">Escanear com o celular</p>
                    </div>
                  </button>
                  <button
                    onClick={() => setConnectMode("pairing")}
                    className="flex flex-col items-center gap-2 p-4 rounded-xl border border-border hover:border-primary/50 hover:bg-primary/5 transition-all text-left"
                  >
                    <span className="text-2xl">#️⃣</span>
                    <div>
                      <p className="text-sm font-medium">Código</p>
                      <p className="text-xs text-muted-foreground">Vincular pelo número</p>
                    </div>
                  </button>
                </div>
              </div>
            )}

            {/* Modo QR */}
            {connectMode === "qr" && waStatus === "connecting" && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Abra o WhatsApp → <strong>Aparelhos conectados</strong> → <strong>Conectar aparelho</strong> → escaneie:
                </p>
                {waQrcode ? (
                  <div className="flex flex-col items-center gap-2">
                    <img
                      src={waQrcode.startsWith("data:") ? waQrcode : `data:image/png;base64,${waQrcode}`}
                      alt="QR Code WhatsApp"
                      className="w-56 h-56 rounded-lg border"
                    />
                    <p className="text-xs text-muted-foreground">
                      QR renova em <span className="font-semibold text-foreground">{qrCountdown}s</span>
                    </p>
                  </div>
                ) : (
                  <div className="flex justify-center items-center w-56 h-56 mx-auto rounded-lg border bg-muted/30">
                    <span className="text-sm text-muted-foreground">Aguardando QR code...</span>
                  </div>
                )}
              </div>
            )}

            {/* Modo Pairing — entrada do número */}
            {connectMode === "pairing" && !pairingCode && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Digite o número do WhatsApp que deseja conectar (com DDI + DDD):
                </p>
                <div className="flex gap-2">
                  <Input
                    value={phoneInput}
                    onChange={e => setPhoneInput(e.target.value.replace(/\D/g, ""))}
                    placeholder="5519999999999"
                    className="font-mono"
                    maxLength={15}
                    onKeyDown={e => { if (e.key === "Enter" && phoneInput.length >= 10) handleWaPairingCode(); }}
                  />
                  <Button
                    onClick={handleWaPairingCode}
                    disabled={phoneInput.length < 10 || pairingLoading}
                    className="shrink-0"
                  >
                    {pairingLoading ? "Gerando..." : "Gerar código"}
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground text-xs"
                  onClick={() => setConnectMode("idle")}
                >
                  ← Voltar
                </Button>
              </div>
            )}

            {/* Modo Pairing — exibição do código */}
            {connectMode === "pairing" && pairingCode && (
              <div className="space-y-3">
                <div className="rounded-xl border border-primary/20 bg-primary/5 p-5 text-center space-y-3">
                  <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                    Código de pareamento
                  </p>
                  <p className="text-4xl font-mono font-bold tracking-[0.3em] text-primary">
                    {pairingCode}
                  </p>
                  <div className="text-xs text-muted-foreground space-y-1">
                    <p>No WhatsApp: <span className="text-foreground font-medium">Aparelhos conectados</span></p>
                    <p>→ <span className="text-foreground font-medium">Vincular com número de telefone</span></p>
                    <p>→ Digite o código acima</p>
                  </div>
                  <p className="text-xs text-muted-foreground/70">
                    Código renova em <span className="font-semibold text-foreground">{pairingCountdown}s</span>
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={handleRefreshCode}
                  >
                    Atualizar código
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    onClick={() => { setPairingCode(null); setPhoneInput(""); }}
                  >
                    Trocar número
                  </Button>
                </div>
              </div>
            )}

            {/* Ações */}
            <div className="flex gap-2 pt-1">
              {waStatus === "connected" && (
                <Button variant="destructive" onClick={handleWaDisconnect} disabled={waDisconnecting} className="flex-1">
                  {waDisconnecting ? "Desconectando..." : "Desconectar"}
                </Button>
              )}
              {waStatus === "connecting" && (
                <Button variant="outline" onClick={handleWaDisconnect} disabled={waDisconnecting} className="flex-1">
                  Cancelar
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
