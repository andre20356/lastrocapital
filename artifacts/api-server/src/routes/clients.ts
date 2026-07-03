import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db, clientsTable } from "@workspace/db";
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
import { montarEEnviarAlertaAtraso } from "../services/overdueAlerts";

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

  const resultado = await montarEEnviarAlertaAtraso(req.companyId, clientId);

  if (!resultado.ok) {
    const status = resultado.motivo === "Cliente não encontrado" ? 404 : 400;
    res.status(status).json({ error: resultado.motivo });
    return;
  }

  res.json({ ok: true, sentTo: resultado.sentTo, clientName: resultado.clientName });
});

export default router;
