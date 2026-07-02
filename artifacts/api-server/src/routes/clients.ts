import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db, clientsTable, invoicesTable, companiesTable } from "@workspace/db";
import { calculateInvoiceBreakdown } from "../services/invoiceCalculator";
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

  const fmt = (v: number) =>
    v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  const fmtDate = (d: string | null) => {
    if (!d) return "—";
    const [y, m, day] = d.split("-");
    return `${day}/${m}/${y}`;
  };

  // Busca instância WhatsApp da empresa
  const [company] = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.id, req.companyId));

  if (!company?.whatsappInstance || company.whatsappStatus !== "connected") {
    res.status(400).json({ error: "WhatsApp da empresa não está conectado" });
    return;
  }

  let grandTotal = 0;

  const contractLines = overdue.map((inv, i) => {
    // Sempre calcula os dias reais pela data de vencimento vs hoje
    // Taxa de atraso só começa após 2 dias de carência
    const GRACE_DAYS = 2;
    const totalDays = (() => {
      if (!inv.dueDate) return 0;
      const due = new Date(inv.dueDate + "T00:00:00-03:00"); // fuso Brasil
      return Math.max(0, Math.floor((Date.now() - due.getTime()) / 86_400_000));
    })();
    const realDays = Math.max(0, totalDays - GRACE_DAYS);

    const breakdown = calculateInvoiceBreakdown({ ...inv, daysLate: realDays });
    if (!breakdown) return null;

    const { principal, interestAmount, lateFeeTotal, total } = breakdown;
    const encargos = interestAmount + lateFeeTotal;
    const days     = realDays;
    grandTotal += total;

    const feePerDay = parseFloat(inv.lateFee ?? "0");

    return (
      `📋 *Contrato ${i + 1}* — Venc. ${fmtDate(inv.dueDate)}\n` +
      `   Principal: ${fmt(principal)}\n` +
      `   Juros: ${fmt(interestAmount)}\n` +
      `   Taxa de atraso: ${fmt(feePerDay)}/dia\n` +
      `   Dias em atraso: ${totalDays} dia${totalDays !== 1 ? "s" : ""} (cobrança a partir do 3º dia)\n` +
      `   Total encargos: ${fmt(encargos)}\n` +
      `   Subtotal: *${fmt(total)}*`
    );
  }).filter(Boolean).join("\n\n");

  const nomeEmpresa = company.name ?? "Nossa Empresa";

  const msg =
    `🔴 *Aviso de Atraso — ${nomeEmpresa}*\n\n` +
    `Olá, ${client.name}.\n\n` +
    `Identificamos as seguintes pendências em seu(s) contrato(s):\n\n` +
    contractLines + "\n\n" +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💰 *Total para quitação: ${fmt(grandTotal)}*\n\n` +
    `Para efetuar o pagamento, digite *menu*.\n\n` +
    `⚠️ *O envio do comprovante é obrigatório.* Sem ele, o sistema não identifica seu pagamento e taxas de atraso adicionais poderão ser geradas.\n\n` +
    `*${nomeEmpresa}*`;

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
