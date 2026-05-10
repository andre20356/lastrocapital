# Deploy — LastroCapital em VPS (lastrocapital.online)

## Pré-requisitos na VPS

- Ubuntu 22.04 / Debian 12 (recomendado)
- Docker + Docker Compose instalados
- Domínio `lastrocapital.online` apontando para o IP da VPS (registro A no DNS)

## 1. Configurar o Clerk (Autenticação)

1. Crie uma conta em [clerk.com](https://clerk.com) e crie um novo aplicativo
2. No dashboard do Clerk, vá em **Domains** → adicione `lastrocapital.online`
3. Configure o **Proxy URL** como: `https://lastrocapital.online/api/__clerk`
4. Copie as chaves de API (seção **API Keys**)

## 2. Configurar o AbacatePay (Pagamentos)

1. Crie uma conta em [abacatepay.com](https://abacatepay.com)
2. Configure o webhook para: `https://lastrocapital.online/api/webhooks/abacatepay`
3. Copie a API key e o webhook secret

## 3. Subir o projeto para a VPS

```bash
# Na VPS, clone seu repositório
git clone https://github.com/SEU_USUARIO/lastrocapital.git
cd lastrocapital
```

## 4. Configurar variáveis de ambiente

```bash
cp .env.example .env
nano .env
```

Preencha todos os valores no `.env`:
- `DATABASE_URL` — gerado automaticamente pelo Docker Compose (veja abaixo)
- `CLERK_SECRET_KEY` / `CLERK_PUBLISHABLE_KEY` / `VITE_CLERK_PUBLISHABLE_KEY` — do dashboard do Clerk
- `ABACATEPAY_API_KEY` / `ABACATEPAY_WEBHOOK_SECRET` — do AbacatePay
- `DB_PASSWORD` — uma senha forte para o banco

Exemplo de `DATABASE_URL` usando o banco do Docker Compose:
```
DATABASE_URL=postgresql://lastrocapital:SUA_SENHA@db:5432/lastrocapital
DB_PASSWORD=SUA_SENHA
```

## 5. Configurar SSL (HTTPS)

```bash
# Instale o Certbot
apt install certbot -y

# Gere o certificado (com o Nginx desligado momentaneamente)
certbot certonly --standalone -d lastrocapital.online -d www.lastrocapital.online

# Copie os certificados
mkdir -p nginx/ssl
cp /etc/letsencrypt/live/lastrocapital.online/fullchain.pem nginx/ssl/
cp /etc/letsencrypt/live/lastrocapital.online/privkey.pem nginx/ssl/
chmod 600 nginx/ssl/*.pem
```

## 6. Fazer o primeiro deploy

```bash
# Build e suba todos os serviços
docker compose --env-file .env up -d --build

# Verifique os logs
docker compose logs -f

# Rode as migrations do banco (apenas na primeira vez)
docker compose exec api node -e "
  const { db } = await import('./dist/index.mjs');
" 2>/dev/null || true
```

> **Alternativa para migrations:** use `pnpm --filter @workspace/db run push` localmente
> apontando para o banco de produção via `DATABASE_URL`.

## 7. Renovação automática do SSL

```bash
# Adicione ao crontab (roda toda segunda-feira à meia-noite)
crontab -e
0 0 * * 1 certbot renew --quiet && cp /etc/letsencrypt/live/lastrocapital.online/fullchain.pem /seu/caminho/lastrocapital/nginx/ssl/ && cp /etc/letsencrypt/live/lastrocapital.online/privkey.pem /seu/caminho/lastrocapital/nginx/ssl/ && docker compose -f /seu/caminho/lastrocapital/docker-compose.yml exec nginx nginx -s reload
```

## 8. Atualizar após mudanças no código

```bash
git pull
docker compose --env-file .env up -d --build
```

## Estrutura dos serviços Docker

| Serviço | Porta interna | Descrição |
|---------|--------------|-----------|
| `db`    | 5432         | PostgreSQL |
| `api`   | 8080         | API Express |
| `web`   | 80           | Frontend React (estático) |
| `nginx` | 80 / 443     | Reverse proxy + SSL |

## Rotas

| URL | Destino |
|-----|---------|
| `https://lastrocapital.online/` | Frontend (React SPA) |
| `https://lastrocapital.online/api/` | API (Express) |
| `https://lastrocapital.online/api/__clerk` | Proxy Clerk (auth) |
| `https://lastrocapital.online/api/webhooks/abacatepay` | Webhook pagamentos |
