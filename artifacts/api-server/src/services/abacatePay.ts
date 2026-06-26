const ABACATEPAY_BASE_URL = "https://api.abacatepay.com/v2";

function getApiKey(): string {
  const key = process.env.ABACATEPAY_API_KEY;
  if (!key) throw new Error("ABACATEPAY_API_KEY environment variable not set");
  return key;
}

function headers() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${getApiKey()}`,
  };
}

export const PLANOS = {
  pro: {
    productId: "prod_yB6j1ZBr3ZHbGDs5Q4ZM3XCR",
    name: "Plano Pro",
    price: 5990,
    label: "R$59,90",
  },
  enterprise: {
    productId: "prod_DRQmjqEsn1QfTnnag5rY4bTS",
    name: "Plano Empresa",
    price: 9990,
    label: "R$99,90",
  },
} as const;

export type PlanKey = keyof typeof PLANOS;

export interface AbacateCustomer {
  id: string;
  name: string;
  email: string;
  cellphone?: string;
  taxId?: string;
}

export interface AbacateCheckout {
  id: string;
  url: string;
  status: string;
  amount: number;
}

export async function createCustomer(params: {
  name: string;
  email: string;
  cellphone?: string;
  taxId?: string;
}): Promise<AbacateCustomer> {
  const body: Record<string, string> = {
    email: params.email,
    name: params.name,
    cellphone: params.cellphone?.replace(/\D/g, "") || "00000000000",
  };
  if (params.taxId) body.taxId = params.taxId;

  const res = await fetch(`${ABACATEPAY_BASE_URL}/customers/create`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AbacatePay createCustomer failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { data: AbacateCustomer };
  return data.data;
}

export async function createCheckout(params: {
  customer: AbacateCustomer;
  planKey: PlanKey;
  returnUrl: string;
  completionUrl: string;
  companyId?: string;
}): Promise<AbacateCheckout> {
  const plan = PLANOS[params.planKey];

  const res = await fetch(`${ABACATEPAY_BASE_URL}/checkouts/create`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      items: [{ id: plan.productId, quantity: 1 }],
      customerId: params.customer.id,
      returnUrl: params.returnUrl,
      completionUrl: params.completionUrl,
      metadata: { companyId: params.companyId, planKey: params.planKey },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AbacatePay createCheckout failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { data: AbacateCheckout };
  return data.data;
}
