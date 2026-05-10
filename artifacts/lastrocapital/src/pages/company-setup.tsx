import { useRegisterCompany, getGetMyCompanyQueryKey } from "@workspace/api-client-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useQueryClient } from "@tanstack/react-query";

function formatCnpj(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 14);
  if (digits.length <= 11) {
    return digits
      .replace(/(\d{3})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
  }
  return digits
    .replace(/(\d{2})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1/$2")
    .replace(/(\d{4})(\d{1,2})$/, "$1-$2");
}

const schema = z.object({
  name: z.string().min(1, "Nome da empresa é obrigatório"),
  cnpj: z
    .string()
    .optional()
    .transform((v) => (v ? v.replace(/\D/g, "") : undefined))
    .refine(
      (v) => !v || v.length === 11 || v.length === 14,
      "Informe um CPF (11 dígitos) ou CNPJ (14 dígitos) válido",
    ),
});

export default function CompanySetup() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const registerCompany = useRegisterCompany();

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", cnpj: "" },
  });

  const onSubmit = (values: z.infer<typeof schema>) => {
    registerCompany.mutate(
      { data: { name: values.name, cnpj: values.cnpj || undefined } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetMyCompanyQueryKey() });
          setLocation("/dashboard");
        },
      },
    );
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-md space-y-8 p-8 border border-border rounded-xl bg-card">
        <div>
          <h2 className="text-2xl font-bold text-center">Bem-vindo ao LastroCapital</h2>
          <p className="text-center text-muted-foreground mt-2">Configure sua empresa para começar</p>
        </div>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nome da Empresa</FormLabel>
                  <FormControl>
                    <Input placeholder="Minha Empresa Ltda" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="cnpj"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>CNPJ / CPF <span className="text-muted-foreground font-normal">(opcional — necessário para pagamentos)</span></FormLabel>
                  <FormControl>
                    <Input
                      placeholder="00.000.000/0001-00"
                      value={field.value ?? ""}
                      onChange={(e) => {
                        field.onChange(formatCnpj(e.target.value));
                      }}
                      inputMode="numeric"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" className="w-full" disabled={registerCompany.isPending}>
              {registerCompany.isPending ? "Configurando..." : "Concluir Cadastro"}
            </Button>
          </form>
        </Form>
      </div>
    </div>
  );
}
