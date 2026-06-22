import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const companiesTable = pgTable("companies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  cnpj: text("cnpj"),
  plan: text("plan").notNull().default("free"),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  telegramBotToken: text("telegram_bot_token"),
  telegramChatId: text("telegram_chat_id"),
  pixKey: text("pix_key"),
  pixKeyType: text("pix_key_type"),
  pixRecipientName: text("pix_recipient_name"),
  pixBankName: text("pix_bank_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCompanySchema = createInsertSchema(companiesTable).omit({ id: true, createdAt: true });
export type InsertCompany = z.infer<typeof insertCompanySchema>;
export type Company = typeof companiesTable.$inferSelect;
