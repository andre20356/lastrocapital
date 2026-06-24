import { useEffect, useRef } from "react";
import { ClerkProvider, Show, useClerk, useAuth, ClerkLoading, ClerkLoaded } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { Switch, Route, useLocation, Router as WouterRouter, Redirect } from 'wouter';
import { QueryClientProvider, useQueryClient, QueryClient, QueryCache } from "@tanstack/react-query";
import { useGetMyCompany, getGetMyCompanyQueryKey, setAuthTokenGetter } from "@workspace/api-client-react";
import { Toaster } from "@/components/ui/toaster";

import Landing from "./pages/landing";
import SignInPage from "./pages/sign-in";
import SignUpPage from "./pages/sign-up";
import Dashboard from "./pages/dashboard";
import CompanySetup from "./pages/company-setup";
import Clients from "./pages/clients";
import CashFlow from "./pages/cashflow";
import Invoices from "./pages/invoices";
import Debts from "./pages/debts";
import InvitePage from "./pages/invite";
import Planos from "./pages/planos";
import Settings from "./pages/settings";
import ConnectivityPage from "./pages/connectivity";
import NotFound from "./pages/not-found";

// Module-level navigate ref — set by NavigateSync inside the router
let _navigate: ((to: string) => void) | null = null;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        const status = (error as any).status ?? (error as any).response?.status;
        if (status === 401 || status === 402 || status === 403 || status === 404) return false;
        return failureCount < 2;
      },
    },
  },
  queryCache: new QueryCache({
    onError: (error) => {
      const status = (error as any).status ?? (error as any).response?.status;
      const onPlanos = window.location.pathname.endsWith("/planos");
      if (status === 402 && _navigate && !onPlanos) {
        _navigate("/planos");
      }
    },
  }),
});

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY');
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "none" as const,
  },
  variables: {
    colorPrimary: "hsl(142 72% 29%)",
    colorForeground: "hsl(220 25% 12%)",
    colorMutedForeground: "hsl(220 15% 45%)",
    colorDanger: "hsl(0 84% 55%)",
    colorBackground: "hsl(0 0% 100%)",
    colorInput: "hsl(220 15% 88%)",
    colorInputForeground: "hsl(220 25% 12%)",
    colorNeutral: "hsl(220 15% 84%)",
    fontFamily: "'Inter', system-ui, sans-serif",
    borderRadius: "0.375rem",
  },
  elements: {
    rootBox: "w-full",
    cardBox: "bg-white rounded-xl w-full max-w-full overflow-hidden border border-[#dde2e8] shadow-sm",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "hidden",
    headerSubtitle: "hidden",
    header: "hidden",
  },
};

function ClerkAuthSync() {
  const { getToken } = useAuth();

  useEffect(() => {
    setAuthTokenGetter(() => getToken());
    return () => setAuthTokenGetter(null);
  }, [getToken]);

  return null;
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const queryClient = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        queryClient.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, queryClient]);

  return null;
}

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { data: company, isLoading, error } = useGetMyCompany({
    query: {
      queryKey: getGetMyCompanyQueryKey(),
      retry: 2,
      retryDelay: 1500,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    }
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center text-foreground">
        <div className="animate-pulse text-muted-foreground">Carregando...</div>
      </div>
    );
  }

  if (error) {
    const status = (error as any).status ?? (error as any).response?.status;
    if (status === 404) return <Redirect to="/company-setup" />;
    if (status === 401 || status === 403) {
      return <Redirect to="/" />;
    }
    return (
      <div className="min-h-screen bg-background flex items-center justify-center text-foreground">
        <div className="text-muted-foreground">Erro ao carregar. Tente novamente.</div>
      </div>
    );
  }

  if (company) return <Component />;
  return <Redirect to="/" />;
}

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/dashboard" />
      </Show>
      <Show when="signed-out">
        <Landing />
      </Show>
    </>
  );
}

function NavigateSync() {
  const [, navigate] = useLocation();
  useEffect(() => {
    _navigate = navigate;
    return () => { _navigate = null; };
  }, [navigate]);
  return null;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <ClerkLoading>
          <div className="min-h-screen bg-background flex items-center justify-center">
            <div className="animate-pulse text-muted-foreground text-sm">Carregando...</div>
          </div>
        </ClerkLoading>
        <NavigateSync />
        <ClerkLoaded>
          <ClerkAuthSync />
          <Switch>
            <Route path="/" component={HomeRedirect} />
            <Route path="/sign-in/*?" component={SignInPage} />
            <Route path="/sign-up/*?" component={SignUpPage} />

            <Route path="/invite/:companyId" component={InvitePage} />

            <Route path="/company-setup">
              <Show when="signed-in"><CompanySetup /></Show>
              <Show when="signed-out"><Redirect to="/" /></Show>
            </Route>

            <Route path="/dashboard">
              <Show when="signed-in"><ProtectedRoute component={Dashboard} /></Show>
              <Show when="signed-out"><Redirect to="/" /></Show>
            </Route>

            <Route path="/clients">
              <Show when="signed-in"><ProtectedRoute component={Clients} /></Show>
              <Show when="signed-out"><Redirect to="/" /></Show>
            </Route>

            <Route path="/cashflow">
              <Show when="signed-in"><ProtectedRoute component={CashFlow} /></Show>
              <Show when="signed-out"><Redirect to="/" /></Show>
            </Route>

            <Route path="/invoices">
              <Show when="signed-in"><ProtectedRoute component={Invoices} /></Show>
              <Show when="signed-out"><Redirect to="/" /></Show>
            </Route>

            <Route path="/debts">
              <Show when="signed-in"><ProtectedRoute component={Debts} /></Show>
              <Show when="signed-out"><Redirect to="/" /></Show>
            </Route>

            <Route path="/planos">
              <Show when="signed-in"><ProtectedRoute component={Planos} /></Show>
              <Show when="signed-out"><Redirect to="/" /></Show>
            </Route>

            <Route path="/connectivity">
              <Show when="signed-in"><ProtectedRoute component={ConnectivityPage} /></Show>
              <Show when="signed-out"><Redirect to="/" /></Show>
            </Route>

            <Route path="/settings">
              <Show when="signed-in"><ProtectedRoute component={Settings} /></Show>
              <Show when="signed-out"><Redirect to="/" /></Show>
            </Route>

            <Route component={NotFound} />
          </Switch>
        </ClerkLoaded>
        <Toaster />
      </QueryClientProvider>
    </ClerkProvider>
  );
}

export default function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}
