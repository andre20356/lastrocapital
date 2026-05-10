import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";
import { invoicesTable } from "./invoices";

export const debtsTable = pgTable("debts", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companiesTable.id).notNull(),
  clientId: integer("client_id").references(() => clientsTable.id, { onDelete: "cascade" }).notNull(),
  invoiceId: integer("invoice_id").references(() => invoicesTable.id),
  status: text("status").notNull().default("open"),
  daysOverdue: integer("days_overdue").notNull().default(0),
});

export const insertDebtSchema = createInsertSchema(debtsTable).omit({ id: true });
export type InsertDebt = z.infer<typeof insertDebtSchema>;
export type Debt = typeof debtsTable.$inferSelect;
