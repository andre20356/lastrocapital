import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

export const clientsTable = pgTable("clients", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companiesTable.id).notNull(),
  name: text("name").notNull(),
  phone: text("phone"),
  email: text("email"),
  document: text("document"),
  status: text("status").notNull().default("active"),
  referralSource: text("referral_source"),
  telegramChatId: text("telegram_chat_id"),
  whatsappJid: text("whatsapp_jid"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertClientSchema = createInsertSchema(clientsTable).omit({ id: true, createdAt: true });
export type InsertClient = z.infer<typeof insertClientSchema>;
export type Client = typeof clientsTable.$inferSelect;
