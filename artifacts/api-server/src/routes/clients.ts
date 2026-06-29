import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db, clientsTable, invoicesTable, companiesTable } from "@workspace/db";
import {
  CreateClientBody,
  UpdateClientBody,
  GetClientParams,
  UpdateClientParams,
  DeleteClientParams,
  ListClientsQueryParams,
} from "@workspace/api-zod";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { checkClientLimit } from "../services/planLimits";
import { sendWA } from "../services/whatsappCommands";

const router = Router();

router.get("/clients", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.status(404).json({ error: "No company found for this user" });
    return;
  }

  const query = ListClientsQueryParams.safeParse(req.query);
  const status = query.success ? query.data.status : undefined;

  let conditions = [eq(clientsTable.companyId, req.companyId)];

  if (status && status !== "all") {
    conditions.push(eq(clientsTable.status, status));
  }

  const clients = await db
    .select()
    .from(clientsTable)
    .where(and(...conditions))
    .orderBy(clientsTable.createdAt);

  res.json(clients);
});

router.post("/clients", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.status(404).json({ error: "No company found for this user" });
    return;
  }

  const limitCheck = await checkClientLimit(req.companyId);
  if (!limitCheck.allowed) {
    res.status(403).json({
      error: `Limite de clientes atingido (${limitCheck.current}/${limitCheck.limit}). Faça upgrade do seu plano para adicionar mais clientes.`,
      code: "PLAN_LIMIT_REACHED",
      resource: "clients",
      current: limitCheck.current,
      limit: limitCheck.limit,
    });
    return;
  }

  const parsed = CreateClientBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [client] = await db
    .insert(clientsTable)
    .values({ ...parsed.data, companyId: req.companyId })
    .returning();

  res.status(201).json(client);
});

router.get("/clients/:id", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.status(404).json({ error: "No company found for this user" });
    return;
  }

  const params = GetClientParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [client] = await db
    .select()
    .from(clientsTable)
    .where(and(eq(clientsTable.id, params.data.id), eq(clientsTable.companyId, req.companyId)));

  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  res.json(client);
});

router.patch("/clients/:id", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.status(404).json({ error: "No company found for this user" });
    return;
  }

  const params = UpdateClientParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateClientBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [client] = await db
    .update(clientsTable)
    .set(parsed.data)
    .where(and(eq(clientsTable.id, params.data.id), eq(clientsTable.companyId, req.companyId)))
    .returning();

  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  res.json(client);
});

router.delete("/clients/:id", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.status(404).json({ error: "No company found for this user" });
    return;
  }

  const params = DeleteClientParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [client] = await db
    .delete(clientsTable)
    .where(and(eq(clientsTable.id, params.data.id), eq(clientsTable.companyId, req.companyId)))
    .returning();

  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  res.sendStatus(204);
});

// POST /clients/:id/send-overdue-alert — envia alerta de atraso via WhatsApp automático
router.post("/clients/:id/send-overdue-alert", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!req.companyId) {
    res.status(404).json({ error: "No company found for this user" });
    return;
  }

  const clientId = parseInt(req.params.id as string, 10);
  if (isNaN(clientId)) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }

  // Busca cliente
  const [client] = await db
    .select()
    .from(clientsTable)
    .where(and(eq(clientsTable.id, clientId), eq(clientsTable.companyId, req.companyId)));

  if (!client) {
    res.status(404).json({ error: "Cliente não encontrado" });
    return;
  }

  if (!client.phone) {
    res.status(400).json({ error: "Cliente sem telefone cadastrado" });
    return;
  }

  // Busca faturas em atraso do cliente
  const overdue = await db
    .select()
    .from(invoicesTable)
    .where(and(
      eq(invoicesTable.companyId, req.companyId),
      eq(invoicesTable.clientId, clientId),
      eq(invoicesTable.status, "overdue"),
    ));

  if (overdue.length === 0) {
    res.status(400).json({ error: "Cliente não possui faturas em atraso" });
    return;
  }

  const principal = overdue.reduce((s, inv) => s + parseFloat(inv.amount ?? "0"), 0);
  const interest  = overdue.reduce((s, inv) => s + parseFloat(inv.amount ?? "0") * parseFloat(inv.interestRate ?? "0") / 100, 0);
  const lateFees  = overdue.reduce((s, inv) => s + parseFloat(inv.lateFee ?? "0"), 0);
  const total     = principal + interest + lateFees;

  const fmt = (v: number) =>
    v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  const msg =
    `🔴 *Aviso de Atraso — Lastro Capital Gestão de Negócio*\n\n` +
    `Olá, ${client.name}.\n\n` +
    `Identificamos pendências em seu contrato. Seguem os detalhes:\n\n` +
    `📌 Valor principal: ${fmt(principal)}\n` +
    `📌 Juros em atraso: ${fmt(interest)}\n` +
    `📌 Taxas de atraso: ${fmt(lateFees)}\n` +
    `📌 *Total para quitação: ${fmt(total)}*\n\n` +
    `Solicitamos contato imediato com nossa equipe para regularização do valor em aberto e evitar encargos adicionais.\n\n` +
    `Após o pagamento, envie o comprovante para atualização do seu contrato.\n\n` +
    `Agradecemos sua atenção.\n` +
    `*Lastro Capital Gestão de Negócio*`;

  // Busca instância WhatsApp da empresa
  const [company] = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.id, req.companyId));

  if (!company?.whatsappInstance || company.whatsappStatus !== "connected") {
    res.status(400).json({ error: "WhatsApp da empresa não está conectado" });
    return;
  }

  const cfg = {
    apiUrl:     process.env.EVOLUTION_SERVER_URL ?? "http://evolution:8080",
    apiKey:     process.env.EVOLUTION_API_KEY ?? "",
    instance:   company.whatsappInstance,
    adminPhone: company.whatsappPhone ?? "",
    companyId:  req.companyId,
  };

  await sendWA(cfg, client.phone, msg);

  res.json({ ok: true, sentTo: client.phone, clientName: client.name });
});

export default router;
