import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background">
      <Card className="w-full max-w-md mx-4">
        <CardContent className="pt-6">
          <div className="flex mb-4 gap-3 items-center">
            <AlertCircle className="h-8 w-8 text-destructive" />
            <h1 className="text-2xl font-bold text-foreground">Página não encontrada</h1>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            A página que você está procurando não existe ou foi movida.
          </p>
          <div className="mt-6">
            <Link href="/">
              <Button className="w-full">Voltar ao início</Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
