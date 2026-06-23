import { Router, type IRouter } from "express";
import healthRouter from "./health";
import companiesRouter from "./companies";
import clientsRouter from "./clients";
import cashflowRouter from "./cashflow";
import invoicesRouter from "./invoices";
import debtsRouter from "./debts";
import dashboardRouter from "./dashboard";
import inviteRouter from "./invite";
import subscriptionsRouter from "./subscriptions";
import webhooksRouter from "./webhooks";
import { requireAuth } from "../middlewares/requireAuth";
import { requireActiveSubscription } from "../middlewares/requireActiveSubscription";

const router: IRouter = Router();

router.use(healthRouter);
router.use(companiesRouter);
router.use(inviteRouter);
router.use(webhooksRouter);
router.use(subscriptionsRouter);

const subscriptionProtectedPaths = [
  "/clients",
  "/cashflow",
  "/invoices",
  "/debts",
  "/dashboard",
];
router.use(subscriptionProtectedPaths, requireAuth as any, requireActiveSubscription);

router.use(clientsRouter);
router.use(cashflowRouter);
router.use(invoicesRouter);
router.use(debtsRouter);
router.use(dashboardRouter);

export default router;
