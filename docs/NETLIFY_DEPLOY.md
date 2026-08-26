# Deploy do Frontend no Netlify

O OpenCord tem dois componentes:
- **Frontend** (React/Vite) → hospeda no Netlify
- **Backend** (Node/Express + SQLite) → hospeda num servidor separado (Railway, Render, VPS, etc.)

---

## 1. Hospedar o Backend

O backend precisa de um servidor com Node.js ≥ 24 e acesso a disco persistente (para o SQLite).

Opções recomendadas:
- [Railway](https://railway.app) — fácil, plano gratuito disponível
- [Render](https://render.com) — plano gratuito (dorme após inatividade)
- VPS própria (DigitalOcean, Contabo, etc.)

### Variáveis de ambiente do backend
```
PORT=4000
COOKIE_SECURE=true
```

Anote a URL pública do seu backend. Ex: `https://opencord-backend.railway.app`

---

## 2. Deploy do Frontend no Netlify

### Via interface web (mais fácil)

1. Acesse [app.netlify.com](https://app.netlify.com) e faça login
2. Clique em **"Add new site" → "Import an existing project"**
3. Conecte seu repositório GitHub/GitLab/Bitbucket
4. Configure:
   - **Base directory:** `client`
   - **Build command:** `npm run build`
   - **Publish directory:** `client/dist`
5. Em **"Environment variables"**, adicione:
   ```
   VITE_API_URL = https://sua-url-do-backend.com
   ```
6. Clique em **"Deploy site"**

### Via Netlify CLI

```bash
npm install -g netlify-cli
netlify login
netlify init
netlify deploy --prod
```

---

## 3. CORS no Backend

Configure o backend para aceitar requisições da URL do Netlify.

No arquivo `server/src/index.ts`, certifique-se de que o CORS permite sua URL do Netlify:

```
ALLOWED_ORIGIN=https://seu-site.netlify.app
```

---

## 4. Testando

Após o deploy, acesse `https://seu-site.netlify.app`.
- O frontend vai conectar em `VITE_API_URL` para chamadas HTTP
- O Socket.IO também conecta em `VITE_API_URL`
- Cookies de sessão são enviados com `credentials: 'include'`

> **Importante:** O backend precisa estar em HTTPS para que cookies funcionem corretamente.
