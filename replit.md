# LastroCapital

SaaS de gestão financeira para pequenas e médias empresas brasileiras — controle de clientes, fluxo de caixa, cobranças e dívidas.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080, served at /api)
- `pnpm --filter @workspace/lastrocapital run dev` — run the frontend (port varies, served at /)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required env: `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PUBLISHABLE_KEY` — auto-provisioned by Replit Clerk integration

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 + Clerk auth (@clerk/express)
- Frontend: React + Vite + Wouter + Clerk React (@clerk/react) + Recharts
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — OpenAPI contract (source of truth)
- `lib/db/src/schema/` — Drizzle schema files (companies, clients, cashflow, invoices, debts)
- `artifacts/api-server/src/routes/` — Express route handlers
- `artifacts/api-server/src/services/` — Business logic services (invoiceCalculator)
- `artifacts/api-server/src/middlewares/` — Auth middleware (requireAuth, clerkProxyMiddleware, requireActiveSubscription)
- `artifacts/lastrocapital/src/` — React frontend (pages, components)
- `lib/api-client-react/src/generated/` — Generated React Query hooks (do not edit)
- `lib/api-zod/src/generated/` — Generated Zod schemas (do not edit)

## Architecture decisions

- Multi-tenant SaaS: each Clerk user maps to one company via `companies.clerk_user_id`
- `requireAuth` middleware resolves `companyId` from the Clerk userId on every request
- All API routes are company-scoped (no cross-company data leakage)
- Invoices marked "overdue" automatically create a Debt record
- Currency formatted in pt-BR locale (R$)
- Invite endpoints (`GET /invite/:companyId`, `POST /clients/public-create`) are public — no auth required
- Invoice `totalDue` is computed server-side: `amount + (amount * interestRate / 100) + (amount * lateFee / 100)` when status = "overdue"
- Subscription plans: `free` (15-day trial, no payment), `pro` (R$59,90/mo), `enterprise` (R$99,90/mo)
- Free trial activated via `POST /subscriptions/start-trial` (no AbacatePay, immediate, one-time per company)
- Paid plans go through `POST /subscriptions/create-checkout` → AbacatePay PIX checkout → webhook activates
- `requireActiveSubscription` middleware gates all business routes (clients, cashflow, invoices, debts, dashboard); allows `trial` if not expired or `active`
- Subscription statuses: `trial`, `pending`, `active`, `past_due`, `canceled`
- AbacatePay webhook at `POST /webhooks/abacatepay` — `subscription.paid` → active, `subscription.canceled` → canceled, `payment.failed` → past_due
- Required env: `ABACATEPAY_API_KEY` — AbacatePay secret key
- Optional env: `ABACATEPAY_WEBHOOK_SECRET` — HMAC secret for webhook signature verification

## Product

- Landing page for unauthenticated users with sign-up CTA
- Dashboard: key financial metrics + pie chart (financial overview) + daily bar/line chart (cashflow evolution)
- Clients: full CRUD + WhatsApp button (opens wa.me with pre-filled message) + invite link copy
- Cash Flow: income/expense entries with category grouping
- Invoices: create/manage invoices with interest rate and late fee fields; shows totalDue for overdue invoices
- Debts: view and close overdue debt records
- Public invite page `/invite/:companyId` — clients self-register without needing a login
- Plans page `/planos`: 3 cards — Free Trial (15 dias), Pro (R$59,90), Empresa (R$99,90)

## User preferences

- Language: Portuguese (Brazilian) — labels and content should be in pt-BR
- Currency: R$ (Brazilian Real, pt-BR locale formatting)

## Gotchas

- Always re-run codegen (`pnpm --filter @workspace/api-spec run codegen`) after changing openapi.yaml
- Always run `pnpm --filter @workspace/db run push` after changing schema files
- The Clerk proxy middleware is production-only — dev works without it
- `requireAuth` also resolves `companyId`; if it's undefined, the user hasn't registered a company yet
- Do NOT import `zod` directly in api-server routes — it's not bundled. Use `@workspace/api-zod` generated schemas or plain JS validation

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
