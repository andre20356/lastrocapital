import { pgTable, text, serial, integer, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

export const cashFlowTable = pgTable("cash_flow", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companiesTable.id).notNull(),
  type: text("type").notNull(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  description: text("description"),
  category: text("category"),
  date: timestamp("date", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCashFlowSchema = createInsertSchema(cashFlowTable).omit({ id: true, createdAt: true });
export type InsertCashFlow = z.infer<typeof insertCashFlowSchema>;
export type CashFlow = typeof cashFlowTable.$inferSelect;
