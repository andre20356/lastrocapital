import {
  ClerkProvider,
  SignIn,
  useAuth,
  useUser,
  useClerk,
} from "@clerk/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { ShieldAlert, ShieldCheck, Loader2 } from "lucide-react";
import Dashboard from "./pages/Dashboard";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string;
export const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "";

if (!CLERK_KEY) {
  throw new Error("VITE_CLERK_PUBLISHABLE_KEY não configurado");
}

export default function App() {
  return (
    <ClerkProvider publishableKey={CLERK_KEY}>
      <QueryClientProvider client={queryClient}>
        <AuthGate />
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function AuthGate() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const { user } = useUser();
  const { signOut } = useClerk();

  const authFetch = useCallback(
    async (url: string, opts: RequestInit = {}) => {
      const jwt = await getToken();
      const headers = new Headers(opts.headers);
      if (jwt) headers.set("Authorization", `Bearer ${jwt}`);
      const res = await fetch(API_URL + url, { ...opts, headers });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const e: any = new Error((err as any).error ?? `HTTP ${res.status}`);
        e.status = res.status;
        throw e;
      }
      return res.status === 204 ? null : res.json();
    },
    [getToken],
  );

  const { data: meData, isLoading: meLoading, error: meError } = useQuery({
    queryKey: ["admin-me"],
    queryFn: () => authFetch("/api/admin/me"),
    enabled: !!isSignedIn,
    retry: false,
  });

  if (!isLoaded || (isSignedIn && meLoading)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0f1117]">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#0f1117] gap-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-white" />
          </div>
          <span className="text-xl font-bold text-white">LastroAdmin</span>
        </div>
        <div className="w-full max-w-md">
          <SignIn routing="hash" />
        </div>
      </div>
    );
  }

  if (meError) {
    const status = (meError as any).status;
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#0f1117] gap-4">
        <ShieldAlert className="w-12 h-12 text-red-400" />
        <p className="text-lg font-semibold text-white">
          {status === 403 ? "Acesso negado" : "Erro ao verificar permissões"}
        </p>
        <p className="text-sm text-slate-400">
          {status === 403
            ? `A conta ${user?.primaryEmailAddress?.emailAddress} não tem permissão de admin.`
            : "Tente novamente em instantes."}
        </p>
        <button
          onClick={() => signOut()}
          className="mt-2 px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm text-white transition"
        >
          Sair
        </button>
      </div>
    );
  }

  if (!meData) return null;

  return <Dashboard authFetch={authFetch} />;
}
