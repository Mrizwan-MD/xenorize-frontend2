# XENORIZE MD — Vercel Coordinator

This repository is only the lightweight Vercel frontend/coordinator. The WhatsApp/Baileys process stays on the active bot host or Railway. Vercel selects a healthy worker, forwards pairing requests, aggregates network status, and protects admin requests.

## Folder structure

```text
xenorize-vercel-coordinator/
├── api/
│   └── index.js       # Vercel coordinator API
├── pair.html          # red-black public pairing page
├── admin.html         # password-protected admin dashboard
├── vercel.json        # rewrites for pages and API
├── package.json
├── .env.example       # copy values into Vercel settings; do not upload .env
├── .gitignore
└── README.md
```

## Current active worker

The verified worker is:

```text
http://93.115.106.210:6656
```

The coordinator includes this as a fallback, so the first deployment can work without a worker API key. It also accepts `WORKER_URL_1`, `WORKER_URL_2`, and `WORKER_URL_3` environment variables.

## Method A — GitHub + Vercel dashboard

### 1. Create the GitHub repository

Create a new empty GitHub repository, for example:

```text
xenorize-vercel-coordinator
```

Upload all files from this folder while preserving the `api` folder. The important path is:

```text
api/index.js
```

Do not rename it to `api.js`.

### 2. Import into Vercel

1. Open Vercel and choose **Add New → Project**.
2. Select **Import Git Repository**.
3. Select `xenorize-vercel-coordinator`.
4. Framework preset: **Other**.
5. Root directory: repository root.
6. Build command: leave empty.
7. Output directory: leave empty.
8. Click **Deploy**.

### 3. Add environment variables

The minimum variable is optional because the active worker is built in. It is still recommended to add it explicitly:

```env
WORKER_URL_1=http://93.115.106.210:6656
```

If the Railway worker has no API key, do not add these yet:

```env
# Leave unset until the same values are configured on the worker
# WORKER_API_KEY=...
# PAIRING_API_KEY=...
```

For the protected admin panel, use the same admin password that is configured on the worker:

```env
ADMIN_KEY=your-existing-admin-key
WORKER_ADMIN_KEY=your-existing-admin-key
ALLOWED_ORIGIN=https://YOUR-VERCEL-DOMAIN.vercel.app
```

Add variables in **Project Settings → Environment Variables**, select **Production**, then redeploy.

### 4. Open the deployed pages

```text
https://YOUR-VERCEL-DOMAIN.vercel.app/
https://YOUR-VERCEL-DOMAIN.vercel.app/admin
https://YOUR-VERCEL-DOMAIN.vercel.app/api/health
```

`/api/health` should show the active worker as `ok: true`.

## Method B — Vercel CLI

From this repository folder:

```bash
npm install -g vercel
vercel login
vercel
```

Answer the prompts:

```text
Set up and deploy? Yes
Which scope? Your account
Link to existing project? No
Project name? xenorize-vercel-coordinator
Directory? ./
Override settings? No
```

Add production variables:

```bash
vercel env add WORKER_URL_1 production
vercel env add ADMIN_KEY production
vercel env add WORKER_ADMIN_KEY production
vercel env add ALLOWED_ORIGIN production
```

Then deploy:

```bash
vercel --prod
```

## How the coordinator works

```text
Browser → Vercel /
             │
             ├── /api/code → least-loaded worker /code
             ├── /api/network → all worker network statuses
             ├── /api/status → aggregate active/saved sessions
             └── /api/admin/* → protected worker admin endpoints

Worker → http://93.115.106.210:6656
```

When Worker 2 and Worker 3 are ready, add:

```env
WORKER_URL_2=https://worker-2.example.com
WORKER_URL_3=https://worker-3.example.com
```

The coordinator checks each worker and chooses the one with the lowest `activeUsers` value for a new pairing request.

## Admin features

The `/admin` page supports:

- Bot branding updates
- Custom command add
- Custom command delete
- Premium add
- Premium remove
- Premium list
- Worker/network status

Admin actions require `ADMIN_KEY`. For premium data to be shared between workers, all workers must use the same MongoDB database.

## Worker requirements

The active worker must expose these routes:

```text
GET /ping
GET /public-network-status
GET /public-status
GET /code?number=923XXXXXXXXX
GET /admin/config
POST /admin/config
POST /admin/command
POST /admin/command/delete
GET /admin/premium/list
POST /admin/premium/add
POST /admin/premium/remove
```

The verified active host currently responds to `/ping` and `/public-network-status`.

## Security before production

The current active host is HTTP on a public IP. For production, put it behind HTTPS and configure a worker API key:

Railway/worker:

```env
PAIRING_API_KEY=long-random-secret
ADMIN_KEY=long-random-admin-secret
```

Vercel:

```env
WORKER_API_KEY=the-same-long-random-secret
WORKER_ADMIN_KEY=the-same-long-random-admin-secret
ADMIN_KEY=the-same-long-random-admin-secret
```

Never commit `.env`, MongoDB credentials, or API keys to GitHub.
