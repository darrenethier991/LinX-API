# LinX Backend — Python/FastAPI Full Codebase Plan

## Top-Level Overview

Generate a standalone Python 3.11 + FastAPI backend at `linx-backend/` that enforces the **LinX Economic Laws**:
billing before inference, atomic wallet operations, universal usage logging, enterprise caps, and Stripe subscription gating.
The service is a sibling to the existing React admin dashboard at `linx-site/`.

**Repo root:** `linx-backend/` (inside `c:\linx-site\linx-backend\`)

**Tech stack:** Python 3.11, FastAPI, SQLAlchemy 2.0 (async), PostgreSQL, Stripe SDK, Requests, Pydantic v2, python-dotenv.

**Entry point:** `main.py` mounts the Echo router and the Stripe webhook router, initialises the DB, and starts Uvicorn.

---

## Architecture Overview

```
HTTP Request
    │
    ▼
echo/router.py  (FastAPI APIRouter)
    │
    ├─ 1. service_rate_limit.py   → check per-user rate limit (DB row lock)
    ├─ 2. service_caps.py         → check enterprise caps (soft throttle / hard block)
    ├─ 3. billing/stripe_service.py → validate Stripe subscription status
    ├─ 4. service_billing.py      → prebill: debit wallet (atomic, row-level lock)
    ├─ 5. service_models.py       → call placeholder provider endpoint (requests)
    └─ 6. service_usage.py        → log usage (user + team + global rows)

wallet/service_wallet.py          → balance read + credit top-up
wallet/service_ledger.py          → append ledger entry
billing/stripe_service.py         → subscription check + webhook handler
shared/config.py                  → env vars (python-dotenv)
shared/pricing.py                 → cost constants
shared/types.py                   → shared Pydantic schemas
db/models/*                       → SQLAlchemy 2.0 ORM models
db/session.py                     → async engine + get_db dependency
db/base.py                        → declarative Base
```

---

## LinX Economic Laws — Enforcement Map

| Law | Enforced in |
|-----|-------------|
| 1. Billing before inference | `echo/router.py` step order (prebill → model call) |
| 2. Every message through Echo | Single `POST /echo/chat` endpoint; no other inference route |
| 3. Atomic wallet ops | `service_billing.py` + `service_wallet.py` — `SELECT ... FOR UPDATE` + single transaction |
| 4. Usage always logged | `service_usage.py` called unconditionally after model response |
| 5. Enterprise caps enforced | `service_caps.py` — soft throttle returns 429, hard block returns 403 |
| 6. Stripe subscription gated | `stripe_service.validate_subscription()` called before prebill |
| 7. No free inference | Prebill always runs; model call never executes without successful debit |

---

## Sub-Tasks

---

### Sub-Task 1 — Project Scaffold + Shared Layer
**Status:** [ ] pending

**Intent:** Create the directory skeleton, `requirements.txt`, `.env.example`, and all `__init__.py` files, plus the three shared modules (`config.py`, `pricing.py`, `types.py`). These are imported by every other module so must exist first.

**Expected Outcomes:**
- `linx-backend/` directory exists with full folder tree
- `requirements.txt` lists all dependencies with pinned majors
- `.env.example` documents every required env var
- `shared/config.py` loads and validates all env vars via python-dotenv + raises on missing
- `shared/pricing.py` defines `COST_PER_MESSAGE_CENTS` and tier multipliers
- `shared/types.py` defines shared Pydantic v2 schemas: `ChatRequest`, `ChatResponse`, `BillingResult`, `UsageRecord`, `ProviderResponse`

**Todo List:**
1. Create all directories and `__init__.py` files
2. Write `requirements.txt`
3. Write `.env.example`
4. Write `shared/config.py` — uses `python-dotenv`, exposes a `Settings` instance with: `DATABASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ECHO_PROVIDER_URL`, `ECHO_PROVIDER_API_KEY`
5. Write `shared/pricing.py` — `COST_PER_MESSAGE_CENTS: int = 2`, `ENTERPRISE_SOFT_CAP_MULTIPLIER: float = 0.9`
6. Write `shared/types.py` — all shared Pydantic schemas

**Relevant Context:**
- No existing Python code in workspace
- Pydantic v2 syntax (`model_config`, `Field`, `model_validator`)

---

### Sub-Task 2 — Database Layer (`db/`)
**Status:** [ ] pending

**Intent:** Define the SQLAlchemy 2.0 async ORM models for all seven tables, the declarative Base, and the async session factory with a `get_db` dependency.

**Expected Outcomes:**
- `db/base.py` exports `Base` (declarative base)
- `db/session.py` exports `async_engine`, `AsyncSessionLocal`, and `get_db` (FastAPI dependency)
- All seven models are fully defined with columns, constraints, and relationships
- Models import `Base` from `db/base.py`

**Todo List:**
1. Write `db/base.py` — `DeclarativeBase` subclass
2. Write `db/session.py` — `create_async_engine(DATABASE_URL)`, `async_sessionmaker`, `get_db` async generator dependency
3. Write `db/models/user.py` — `User`: id (UUID PK), email, stripe_customer_id, stripe_subscription_id, stripe_status (enum: active/past_due/canceled/trialing), is_suspended (bool), team_id (FK), role (enum: user/admin), created_at
4. Write `db/models/wallet.py` — `Wallet`: id (UUID PK), owner_id (UUID), owner_type (enum: user/team), balance_cents (int, default 0), daily_spend_cents (int, default 0), hard_limit_cents (int nullable), last_reset_date (date), updated_at
5. Write `db/models/ledger.py` — `LedgerEntry`: id (UUID PK), wallet_id (FK), amount_cents (int, signed), entry_type (enum: debit/credit/refund), description, reference_id, created_at
6. Write `db/models/usage.py` — `UsageStat`: id (UUID PK), scope (enum: user/team/global), scope_id (UUID nullable for global), date (date), message_count (int), total_cost_cents (int), updated_at
7. Write `db/models/caps.py` — `EnterpriseCap`: id (UUID PK), team_id (UUID unique FK), daily_message_soft_cap (int), daily_message_hard_cap (int), monthly_spend_soft_cap_cents (int), monthly_spend_hard_cap_cents (int), status (enum: active/throttled/suspended), updated_at
8. Write `db/models/global_caps.py` — `GlobalCap`: id (int PK, always 1), daily_message_cap (int), current_daily_count (int, default 0), last_reset_date (date), updated_at
9. Write `db/models/rate_limit.py` — `RateLimitEvent`: id (UUID PK), user_id (UUID FK), event_time (datetime), window_start (datetime)

**Relevant Context:**
- Use `sqlalchemy.ext.asyncio` throughout
- UUIDs via `uuid.uuid4` server-side default
- All timestamps use `datetime.utcnow`
- `DATABASE_URL` must use `postgresql+asyncpg://` scheme

---

### Sub-Task 3 — Wallet Services (`wallet/`)
**Status:** [ ] pending

**Intent:** Implement atomic wallet debit/credit using `SELECT ... FOR UPDATE` inside a single transaction, and ledger entry creation.

**Expected Outcomes:**
- `wallet/service_wallet.py` exposes `get_wallet(owner_id, session)`, `debit_wallet(wallet_id, amount_cents, session)` (raises `InsufficientFundsError` if balance < amount), `credit_wallet(wallet_id, amount_cents, session)`
- `wallet/service_ledger.py` exposes `append_ledger_entry(wallet_id, amount_cents, entry_type, description, reference_id, session)`
- Both services operate within a caller-provided session (no internal `commit()`) — the Echo router owns the transaction
- Row-level lock: `SELECT ... FOR UPDATE` via `with_for_update()`

**Todo List:**
1. Write `wallet/service_wallet.py`:
   - `get_wallet()` — query by owner_id, raise `WalletNotFoundError` if missing
   - `debit_wallet()` — `SELECT FOR UPDATE` on wallet row, check balance >= amount, subtract, do NOT commit
   - `credit_wallet()` — `SELECT FOR UPDATE`, add amount, do NOT commit
2. Write `wallet/service_ledger.py`:
   - `append_ledger_entry()` — insert `LedgerEntry` row, do NOT commit

**Relevant Context:**
- `debit_wallet` uses `session.execute(select(Wallet).where(Wallet.id == wallet_id).with_for_update())`
- Errors defined in `shared/types.py` as custom exception classes: `InsufficientFundsError`, `WalletNotFoundError`
- The outer transaction (in `service_billing.py`) calls `session.commit()` after both wallet + ledger operations succeed

---

### Sub-Task 4 — Echo Services (`echo/`)
**Status:** [ ] pending

**Intent:** Implement the five Echo service modules that each enforce one LinX Economic Law, plus the `service_models.py` provider HTTP client.

**Expected Outcomes:**
- `echo/service_rate_limit.py` — checks per-user message rate; inserts `RateLimitEvent`; raises `RateLimitExceededError` if > N messages in last 60 seconds
- `echo/service_caps.py` — reads `EnterpriseCap` for user's team; raises `SoftCapExceededError` (429) or `HardCapExceededError` (403) based on daily counts
- `echo/service_billing.py` — runs debit + ledger in ONE transaction; raises on failure; calls `service_wallet` + `service_ledger`
- `echo/service_usage.py` — upserts `UsageStat` rows for user scope, team scope, and global scope in a single pass
- `echo/service_models.py` — `POST` to `ECHO_PROVIDER_URL` with `Authorization: Bearer ECHO_PROVIDER_API_KEY`; returns `ProviderResponse`

**Todo List:**
1. Write `echo/service_rate_limit.py`:
   - `check_rate_limit(user_id, session)` — count `RateLimitEvent` rows where `event_time > now() - 60s` for user; if >= `RATE_LIMIT_PER_MINUTE` (default 10) raise `RateLimitExceededError`; else insert new event row
2. Write `echo/service_caps.py`:
   - `check_enterprise_caps(team_id, session)` — load `EnterpriseCap` for team; compare today's `UsageStat.message_count` against soft/hard caps; if >= soft cap → update status to `throttled`, raise `SoftCapExceededError`; if >= hard cap → update status to `suspended`, raise `HardCapExceededError`; if status is already `suspended` → raise immediately
3. Write `echo/service_billing.py`:
   - `prebill_message(user_id, cost_cents, session)` → open transaction, `get_wallet(user_id)`, `debit_wallet(...)`, `append_ledger_entry(...)`, `commit()` — single atomic operation; returns `BillingResult`
4. Write `echo/service_usage.py`:
   - `log_usage(user_id, team_id, cost_cents, session)` — upsert `UsageStat` for scope=user, scope=team, scope=global for today's date; increment `message_count` and `total_cost_cents`
5. Write `echo/service_models.py`:
   - `call_provider(request: ChatRequest) -> ProviderResponse` — synchronous `requests.post` to `settings.ECHO_PROVIDER_URL`; includes `Authorization` header; raises `ProviderError` on non-200; returns parsed `ProviderResponse`

**Relevant Context:**
- `service_billing.py` is the ONLY place that calls `session.commit()`
- `service_caps.py` operates on enterprise teams only; PAYG users skip this check
- Upsert in `service_usage.py` uses `INSERT ... ON CONFLICT DO UPDATE` via SQLAlchemy `insert().on_conflict_do_update()`
- `service_models.py` uses synchronous `requests` library (run in threadpool via `asyncio.to_thread` in router)

---

### Sub-Task 5 — Echo Router (`echo/router.py`)
**Status:** [ ] pending

**Intent:** Implement the single `POST /echo/chat` endpoint that sequences all six steps in order, enforcing every LinX Economic Law. This is the critical orchestration layer.

**Expected Outcomes:**
- `POST /echo/chat` accepts `ChatRequest` body + `user_id` header
- Executes exactly in order: rate limit → caps → Stripe → prebill → model → usage
- Model call NEVER executes without a successful prebill (billing before inference)
- On any pre-model error, the wallet is NOT debited
- On model error AFTER prebill, a refund ledger entry is written and wallet is re-credited
- Returns `ChatResponse` with provider reply, cost, and remaining balance

**Todo List:**
1. Write `echo/router.py`:
   - `router = APIRouter(prefix="/echo", tags=["echo"])`
   - `POST /chat` endpoint, async, depends on `get_db`
   - Step 1: `await check_rate_limit(user_id, db)` — raises 429 if exceeded
   - Step 2: load user's team; if enterprise `await check_enterprise_caps(team_id, db)` — raises 429/403
   - Step 3: `await validate_subscription(user_id, db)` from `billing/stripe_service.py` — raises 403 if not active
   - Step 4: `billing_result = await prebill_message(user_id, COST_PER_MESSAGE_CENTS, db)` — raises 402 if insufficient funds
   - Step 5: `provider_response = await asyncio.to_thread(call_provider, request)` — on failure, refund wallet + ledger, raise 502
   - Step 6: `await log_usage(user_id, team_id, COST_PER_MESSAGE_CENTS, db)`
   - Return `ChatResponse`
2. Map custom exception types to correct HTTP status codes via FastAPI exception handlers in `main.py`

**Relevant Context:**
- All service calls share the same `db` session from `get_db`
- `asyncio.to_thread` wraps the synchronous `requests.post` in `service_models.py`
- Refund path: if `call_provider` raises, call `credit_wallet` + `append_ledger_entry(entry_type="refund")` before re-raising

---

### Sub-Task 6 — Stripe Service + Webhook (`billing/stripe_service.py`)
**Status:** [ ] pending

**Intent:** Implement Stripe subscription validation (called before every message) and the webhook handler that keeps `User.stripe_status` and `User.is_suspended` in sync.

**Expected Outcomes:**
- `validate_subscription(user_id, db)` — loads `User`, checks `stripe_status in ('active', 'trialing')`, raises `SubscriptionInactiveError` if not
- `POST /billing/webhook` endpoint verifies Stripe signature, handles `customer.subscription.updated` and `customer.subscription.deleted` events, updates `User` row
- Webhook also sets `is_suspended = True` on `canceled` or `past_due` status
- `create_checkout_session(user_id, price_id)` — creates Stripe Checkout Session for credit top-up
- Stripe client initialised from `settings.STRIPE_SECRET_KEY`

**Todo List:**
1. Write `billing/stripe_service.py`:
   - `init_stripe()` — sets `stripe.api_key = settings.STRIPE_SECRET_KEY`
   - `validate_subscription(user_id, db)` — async, loads User, checks status
   - `handle_webhook(payload, sig_header, db)` — verifies with `stripe.Webhook.construct_event`, dispatches to `_handle_subscription_updated` or `_handle_subscription_deleted`
   - `_handle_subscription_updated(event_data, db)` — finds User by `stripe_customer_id`, updates `stripe_status` + `is_suspended`
   - `_handle_subscription_deleted(event_data, db)` — sets status=`canceled`, `is_suspended=True`
2. Add `POST /billing/webhook` route in `main.py` (raw body required for Stripe signature verification — use `Request.body()` not parsed JSON)

**Relevant Context:**
- Stripe webhook must receive raw bytes for signature verification — cannot use Pydantic body parsing on this route
- `stripe_status` values mirror Stripe's subscription status strings: `active`, `past_due`, `canceled`, `trialing`, `incomplete`
- `STRIPE_WEBHOOK_SECRET` from `shared/config.py`

---

### Sub-Task 7 — Application Entry Point (`main.py`)
**Status:** [ ] pending

**Intent:** Wire all routers, register exception handlers, initialise the DB on startup, and configure CORS.

**Expected Outcomes:**
- `main.py` creates the FastAPI app, includes `echo.router` and the billing webhook router
- `@app.on_event("startup")` creates all DB tables via `Base.metadata.create_all`
- Custom exception handlers map `InsufficientFundsError` → 402, `RateLimitExceededError` → 429, `SoftCapExceededError` → 429, `HardCapExceededError` → 403, `SubscriptionInactiveError` → 403, `ProviderError` → 502
- CORS configured to allow the React admin dashboard origin
- `uvicorn.run` block at bottom for `python main.py` invocation

**Todo List:**
1. Write `main.py`:
   - Import and instantiate `FastAPI(title="LinX API")`
   - Add `CORSMiddleware`
   - Include `echo.router.router` at prefix `/echo`
   - Register all exception handlers
   - `startup` event: run `async_engine.begin()` + `Base.metadata.create_all`
   - Add raw-body Stripe webhook route (`/billing/webhook`)
   - `if __name__ == "__main__": uvicorn.run(...)`

**Relevant Context:**
- `Base.metadata.create_all` with the async engine requires `conn.run_sync(Base.metadata.create_all)`
- Stripe webhook route must extract raw body before any middleware consumes it

---

## File Dependency Order

```
shared/config.py
shared/pricing.py
shared/types.py
db/base.py
db/models/*.py
db/session.py
wallet/service_wallet.py
wallet/service_ledger.py
echo/service_rate_limit.py
echo/service_caps.py
echo/service_billing.py       ← calls wallet services
echo/service_usage.py
echo/service_models.py
echo/router.py                ← orchestrates all echo services
billing/stripe_service.py
main.py                       ← mounts all routers
```

---

## Environment Variables (`.env.example`)

```
DATABASE_URL=postgresql+asyncpg://user:password@localhost:5432/linx
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
ECHO_PROVIDER_URL=https://api.provider.example/v1/chat
ECHO_PROVIDER_API_KEY=...
RATE_LIMIT_PER_MINUTE=10
COST_PER_MESSAGE_CENTS=2
CORS_ORIGINS=http://localhost:5173,http://localhost:3000
```

---

## Key Design Decisions

1. **Single session per request** — `get_db` yields one `AsyncSession` per HTTP request. All services in the Echo pipeline share it. Only `service_billing.py` calls `commit()`.
2. **Synchronous provider call via threadpool** — `requests.post` runs in `asyncio.to_thread()` to avoid blocking the event loop.
3. **Refund on provider failure** — if the model call fails after prebill, the wallet is re-credited and a `refund` ledger entry is written before returning 502.
4. **Enterprise vs PAYG** — caps check is skipped for users with no team or teams not flagged as enterprise. PAYG users only face wallet balance check.
5. **Stripe status cached in DB** — `validate_subscription` reads the local `User.stripe_status` (updated by webhook) rather than calling Stripe on every message, keeping latency low.
6. **Row-level locks** — `SELECT ... FOR UPDATE` on the `Wallet` row prevents race conditions on concurrent debits.
