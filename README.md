# LinX API

Backend and site for **linxservices.ca** — a contractor-network marketplace for Simcoe County.
Cloudflare Workers + D1 + KV, with Supabase as the system of record for CRM data.

## Layout

| Path | What it is |
|---|---|
| `workers/api.js` | Main API worker → `api.linxservices.ca`. Contacts/leads CRM, auth, jobs. |
| `workers/sms.js` | SMS worker → `sms.linxservices.ca`. Twilio send/receive, welcome SMS. |
| `workers/ai-gateway.js` | AI gateway worker → `ai.linxservices.ca`. |
| `wrangler.jsonc` | **The** worker config (single file, `[env]` overrides per worker). |
| `linxservices-site/` | Static marketing + lead-capture site deployed to `linxservices.ca`. |
| `supabase/migrations/` | Billing + contacts schema, RLS policies, indexes. |
| `automations/workflows/` | Lead workflows (qualify, follow-up, welcome SMS). |
| `config/` | Deploy notes (`deploy.md`) and route map (`routes.json`). |
| `deploy-linx.ps1` | Deploys all three workers from a Windows PC. |
| `linx-health.ps1` | Health-checks all three workers after a deploy. |
| `.env.example` | Every env var the project uses — copy to `.env`, never commit `.env`. |

## Deploy

From the repo root on a PC with Wrangler logged in:

```powershell
.\deploy-linx.ps1        # deploys linx-api, linx-sms, linx-ai-gateway
```

Or individually: `wrangler deploy` (api), `wrangler deploy --env sms`, `wrangler deploy --env ai`.

Then verify:

```powershell
.\linx-health.ps1
```

`GET https://api.linxservices.ca/health` must report the current API version.
Public `POST /api/contacts` is the website's lead-intake endpoint (no auth,
rate-limited); authenticated reads stay behind the API token.

## Config & secrets

- `wrangler.jsonc` holds **structure only**: routes, bindings, non-secret vars.
- Secrets (Supabase keys, Twilio, Stripe, `API_INTERNAL_TOKEN`, …) live in the
  Cloudflare dashboard or via `wrangler secret put` — **never in this repo.**
- The repo is public: keep it that way only while convenient; flip it private
  when the cleanup is done.

## Site wiring

`linxservices-site/post-job.html` posts job leads to
`POST https://api.linxservices.ca/api/contacts` (name/email/phone top-level,
job details in `meta`). If the endpoint is unreachable the form shows its
error panel with the support phone number — that is correct behavior, not a
bug. Do not reintroduce demo mode.

## Known gaps

- `linxservices-site/signup.html` redirects each plan to its Stripe Payment Link — paste the live links into `STRIPE_LINKS` in that file and set each link's "after payment" redirect to `https://linxservices.ca/success.html` before publishing. Until then, the signup form honestly tells visitors checkout isn't live yet.
- The job board (`linxservices-site/jobs.html`) fetches `GET https://api.linxservices.ca/api/jobs` (public, rate-limited). The API does not have this route yet — when adding it, return only public-safe fields: `[{ id, post_type, title, trade, city, budget_min, budget_max, employment_type, urgency, description, posted_at }]` (`post_type` is `'project'` or `'hiring'`) and **never** expose poster name, email, or phone. Until the route is live, the page shows its honest empty state. The post form (`post-job.html`) sends `post_type` and `employment_type` in the lead `meta`.
- Site assets: `favicon.svg` (tab icon), `og-image.jpg` (social share card used by the Open Graph/Twitter tags on every page), `404.html` (branded not-found page), `sitemap.xml` (all public pages).
- `wrangler.jsonc` must be reconciled against the live dashboard config
  (routes, D1 binding, vars) before the next `linx-api` production deploy —
  do not deploy over the drift blindly.
