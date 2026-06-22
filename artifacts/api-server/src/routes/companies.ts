import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, companiesTable } from "@workspace/db";
import { RegisterCompanyBody } from "@workspace/api-zod";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { startCompanyBotPolling } from "../services/telegramCommands";

const router = Router();

router.post("/companies/register", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  try {
    const parsed = RegisterCompanyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const existing = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.clerkUserId, req.userId!));

    if (existing.length > 0) {
      res.status(409).json({ error: "Company already registered for this user" });
      return;
    }

    const [company] = await db
      .insert(companiesTable)
      .values({
        name: parsed.data.name,
        cnpj: parsed.data.cnpj ?? null,
        plan: parsed.data.plan ?? "free",
        clerkUserId: req.userId!,
      })
      .returning();

    res.status(201).json(company);
  } catch (err) {
    console.error("[companies] POST /companies/register:", err);
    res.status(500).json({ error: "Erro interno ao registrar empresa" });
  }
});

router.get("/companies/me", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const [company] = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.clerkUserId, req.userId!));

  if (!company) {
    res.status(404).json({ error: "Company not found" });
    return;
  }

  res.json(company);
});

// GET telegram settings
router.get("/companies/telegram", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const [company] = await db
    .select({ telegramBotToken: companiesTable.telegramBotToken, telegramChatId: companiesTable.telegramChatId })
    .from(companiesTable)
    .where(eq(companiesTable.clerkUserId, req.userId!));

  if (!company) { res.status(404).json({ error: "Company not found" }); return; }

  res.json({
    telegramBotToken: company.telegramBotToken ?? "",
    telegramChatId:   company.telegramChatId   ?? "",
  });
});

// PUT telegram settings
router.put("/companies/telegram", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const { telegramBotToken, telegramChatId } = req.body as { telegramBotToken?: string; telegramChatId?: string };

  const [company] = await db
    .update(companiesTable)
    .set({
      telegramBotToken: telegramBotToken?.trim() || null,
      telegramChatId:   telegramChatId?.trim()   || null,
    })
    .where(eq(companiesTable.clerkUserId, req.userId!))
    .returning();

  if (!company) { res.status(404).json({ error: "Company not found" }); return; }

  // Inicia polling do bot recém-configurado se ainda não estiver ativo
  if (company.telegramBotToken) {
    startCompanyBotPolling(company.telegramBotToken, company.id, company.name ?? String(company.id), company.telegramChatId ?? undefined);
  }

  res.json({ ok: true });
});

// GET telegram/bot-info — retorna username e link do bot
router.get("/companies/telegram/bot-info", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  try {
    const [company] = await db
      .select({ telegramBotToken: companiesTable.telegramBotToken })
      .from(companiesTable)
      .where(eq(companiesTable.clerkUserId, req.userId!));

    const token = company?.telegramBotToken?.trim();
    if (!token) { res.status(404).json({ error: "Token não configurado" }); return; }

    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await r.json() as { ok: boolean; result?: { username?: string; first_name?: string } };

    if (!r.ok || !data.ok || !data.result?.username) {
      res.status(400).json({ error: "Não foi possível obter informações do bot" });
      return;
    }

    res.json({
      username: data.result.username,
      link: `https://t.me/${data.result.username}`,
      name: data.result.first_name ?? data.result.username,
    });
  } catch (err) {
    console.error("[telegram/bot-info]:", err);
    res.status(500).json({ error: "Erro ao buscar informações do bot" });
  }
});

// POST telegram/fetch-chat-id — busca o chatId a partir das atualizações recentes do bot
router.post("/companies/telegram/fetch-chat-id", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  try {
    const { telegramBotToken } = req.body as { telegramBotToken?: string };
    const token = telegramBotToken?.trim();
    if (!token) { res.status(400).json({ error: "Token obrigatório" }); return; }

    const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=0&limit=10`);
    const data = await r.json() as { ok: boolean; description?: string; result?: any[] };

    if (!r.ok || !data.ok) {
      res.status(400).json({ error: data.description ?? "Token inválido" });
      return;
    }

    const updates = data.result ?? [];
    let chatId: number | undefined;
    for (const upd of updates.reverse()) {
      const id = upd?.message?.chat?.id ?? upd?.channel_post?.chat?.id ?? upd?.callback_query?.message?.chat?.id;
      if (id) { chatId = id; break; }
    }

    if (!chatId) {
      res.status(404).json({ error: "Nenhuma mensagem encontrada. Envie uma mensagem para o bot primeiro e tente novamente." });
      return;
    }

    res.json({ chatId: String(chatId) });
  } catch (err) {
    console.error("[telegram/fetch-chat-id]:", err);
    res.status(500).json({ error: "Erro ao buscar Chat ID" });
  }
});

// POST telegram/test — envia msg de teste para validar token+chatId
router.post("/companies/telegram/test", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  try {
    const { telegramBotToken, telegramChatId } = req.body as { telegramBotToken?: string; telegramChatId?: string };
    const token  = telegramBotToken?.trim();
    const chatId = telegramChatId?.trim();

    if (!token || !chatId) { res.status(400).json({ error: "Token e Chat ID são obrigatórios" }); return; }

    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: "✅ <b>Lastro Capital</b> — Notificações configuradas com sucesso! Você receberá alertas de vencimento aqui.", parse_mode: "HTML" }),
    });

    const data = await r.json() as { ok: boolean; description?: string };
    if (!r.ok || !data.ok) {
      console.error("[telegram/test] Falha:", { status: r.status, description: data.description, token: token?.slice(0, 10) + "...", chatId });
      res.status(400).json({ error: data.description ?? "Erro ao conectar com o Telegram" });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[companies] POST /companies/telegram/test:", err);
    res.status(500).json({ error: "Erro interno ao testar Telegram" });
  }
});

// GET pix settings
router.get("/companies/pix", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const [company] = await db
    .select({
      pixKey:           companiesTable.pixKey,
      pixKeyType:       companiesTable.pixKeyType,
      pixRecipientName: companiesTable.pixRecipientName,
      pixBankName:      companiesTable.pixBankName,
    })
    .from(companiesTable)
    .where(eq(companiesTable.clerkUserId, req.userId!));
  if (!company) { res.status(404).json({ error: "Company not found" }); return; }
  res.json({
    pixKey:           company.pixKey           ?? "",
    pixKeyType:       company.pixKeyType        ?? "",
    pixRecipientName: company.pixRecipientName  ?? "",
    pixBankName:      company.pixBankName       ?? "",
  });
});

function detectPixKeyType(key: string): string {
  const k = key.trim();
  if (!k) return "";
  if (k.startsWith("+")) return "telefone";
  if (k.includes("@")) return "email";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) return "aleatoria";
  const digits = k.replace(/\D/g, "");
  if (digits.length === 11) return "cpf";
  if (digits.length === 14) return "cnpj";
  return "aleatoria";
}

// PUT pix settings
router.put("/companies/pix", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const { pixKey, pixRecipientName, pixBankName } = req.body as {
    pixKey?: string; pixRecipientName?: string; pixBankName?: string;
  };
  const key = pixKey?.trim() || null;
  const keyType = key ? detectPixKeyType(key) : null;
  const [company] = await db
    .update(companiesTable)
    .set({
      pixKey,
      pixKeyType:       keyType,
      pixRecipientName: pixRecipientName?.trim() || null,
      pixBankName:      pixBankName?.trim()      || null,
    })
    .where(eq(companiesTable.clerkUserId, req.userId!))
    .returning();
  if (!company) { res.status(404).json({ error: "Company not found" }); return; }
  res.json({ ok: true, pixKeyType: keyType });
});

export default router;
