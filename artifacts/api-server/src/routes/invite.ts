import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, companiesTable, clientsTable } from "@workspace/db";

const router = Router();

router.get("/invite/:companyId", async (req, res): Promise<void> => {
  const companyId = parseInt(req.params.companyId ?? "");
  if (isNaN(companyId) || companyId <= 0) {
    res.status(400).json({ error: "ID de empresa inválido" });
    return;
  }

  const [company] = await db
    .select({ id: companiesTable.id, name: companiesTable.name })
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId));

  if (!company) {
    res.status(404).json({ error: "Empresa não encontrada" });
    return;
  }

  res.json({ companyId: company.id, companyName: company.name });
});

router.post("/clients/public-create", async (req, res): Promise<void> => {
  const { companyId, name, phone, email } = req.body ?? {};

  if (!companyId || typeof companyId !== "number" || !name || typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "companyId e name são obrigatórios" });
    return;
  }

  const [company] = await db
    .select({ id: companiesTable.id })
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId));

  if (!company) {
    res.status(404).json({ error: "Empresa não encontrada" });
    return;
  }

  const [client] = await db
    .insert(clientsTable)
    .values({
      companyId,
      name: name.trim(),
      phone: typeof phone === "string" && phone.trim() ? phone.trim() : null,
      email: typeof email === "string" && email.trim() ? email.trim() : null,
      status: "active",
      referralSource: "invite_link",
    })
    .returning();

  res.status(201).json(client);
});

export default router;
