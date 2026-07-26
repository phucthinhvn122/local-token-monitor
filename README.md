# Codex Gateway

A self-hosted, OpenAI-compatible gateway that puts **API keys and raw token quota**
in front of a pool of upstream providers, so a team can share Codex CLI access
with per-person metering.

- **Admins** add upstream providers, issue keys, grant a flat number of tokens, and
  watch usage and pool health.
- **Users** sign in, see how much quota they have left, and get a working
  `~/.codex` configuration in two clicks.
- **Codex CLI** points at `https://your-gateway/v1` and works unchanged.

Every request is authenticated, quota-checked, forwarded to a healthy provider,
measured, and logged. Upstream credentials are encrypted at rest and never
reach a client.

---

## Contents

- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Local development](#local-development)
- [Environment variables](#environment-variables)
- [Connecting Codex CLI](#connecting-codex-cli)
- [How quota is measured](#how-quota-is-measured)
- [Routing and failover](#routing-and-failover)
- [Security](#security)
- [Operations](#operations)
- [API reference](#api-reference)
- [Testing](#testing)
- [Project layout](#project-layout)
- [Known limits](#known-limits)

---

## How it works

```text
        Codex CLI                      Browser
            │  Bearer sk-cgw-…             │  session cookie
            ▼                              ▼
     ┌──────────────────────┐        ┌─────────────┐
     │  Fastify gateway     │◀───────│  Next.js    │  /api/* rewrite
     │  /v1/*  +  /api/*    │        │  dashboard  │
     └──────────┬───────────┘        └─────────────┘
                │
   authenticate key → check quota → rate limit → pick provider
                │
                ▼
     ┌──────────────────────┐
     │  Pool providers      │  round-robin / priority / weighted
     │  (OpenAI-compatible) │  + circuit breaker + failover
     └──────────┬───────────┘
                │  usage from the response (or a local estimate)
                ▼
     ┌──────────────────────┐
     │  PostgreSQL          │  atomic quota deduction + usage log
     └──────────────────────┘
```

The gateway speaks both wire protocols Codex may use — `/v1/chat/completions`
and `/v1/responses` — and streams responses through untouched.

---

## Quick start

Requires Docker with Compose v2.

```bash
git clone https://github.com/phucthinhvn122/local-token-monitor.git
cd local-token-monitor
cp .env.example .env
```

Generate the two required secrets and put them in `.env`:

```bash
echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"
echo "SESSION_SECRET=$(openssl rand -hex 32)"
```

Then set `POSTGRES_PASSWORD`, `DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`,
and `PUBLIC_GATEWAY_URL` (the address your users' Codex CLI will call), and start it:

```bash
docker compose up -d --build
```

The gateway container applies migrations and seeds reference data on start, so
there is no separate setup step.

| Service | URL |
|---|---|
| Dashboard | http://localhost:3000 |
| Gateway (what Codex calls) | http://localhost:4000/v1 |
| Health check | http://localhost:4000/api/health |

### Try it with demo data

To evaluate the dashboard before wiring up a real provider, load three members
spread across the safe / warning / critical quota bands, three pool providers
(one with an open circuit), and 30 days of usage history:

```bash
docker compose exec gateway npx tsx packages/db/src/seed-demo.ts
# locally, outside Docker:  npm run db:seed:demo
```

It prints three sign-ins (password `password123`) and their API keys. It
refuses to run if the database already has members; `-- --reset` removes it
again. The demo providers point at placeholder URLs, so replace one with a real
upstream before proxying anything.

### First steps

Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`, **change that password
immediately**, then:

1. **Pool providers → Add provider** — the upstream base URL and its API key.
   Use **Test connection** before saving.
2. **API keys → New API key** — pick or create a user, enter a token amount
   (e.g. `2000000`), and copy the key that appears. It is shown once.
3. Send the user to **Connect Codex CLI** on their dashboard.

### Production TLS

Codex holds long streaming connections, so the reverse proxy must not buffer or
time them out. A ready Caddy config is included:

```bash
# edit docker/Caddyfile with your two hostnames first
docker compose --profile tls up -d
```

Then set `PUBLIC_GATEWAY_URL=https://gateway.example.com`,
`WEB_ORIGIN=https://dashboard.example.com`, and `COOKIE_SECURE=true`.

---

## Local development

Requires Node.js 22.13+ and a reachable PostgreSQL 14+.

```bash
npm install
cp .env.example .env          # point DATABASE_URL at your local Postgres

npm run db:generate           # generate the Prisma client
npm run db:migrate            # apply migrations
npm run db:seed               # pricing rows + bootstrap admin
npm run db:seed:demo          # optional: demo users, providers, usage history

npm run dev                   # gateway on :4000, dashboard on :3000
```

Open http://localhost:3000. The dashboard proxies `/api/*` to the gateway, so
that is the only port you need in a browser — but Codex CLI talks to
`http://localhost:4000/v1` directly.

Other scripts:

| Command | What it does |
|---|---|
| `npm test` | Run the whole test suite |
| `npm run typecheck` | Typecheck the gateway, packages, and tests |
| `npm run build` | Build the gateway and the dashboard |
| `npm run db:migrate:dev` | Create a new migration from schema changes |
| `npm run db:seed:demo -- --reset` | Remove the demo data |
| `npm run db:studio` | Browse the database in Prisma Studio |

---

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | **yes** | — | PostgreSQL connection string |
| `ENCRYPTION_KEY` | **yes** | — | 32 bytes as 64 hex chars. Encrypts provider credentials and user keys |
| `SESSION_SECRET` | **yes** | — | ≥32 chars. Signs dashboard session cookies |
| `PUBLIC_GATEWAY_URL` | no | `http://localhost:4000` | Baked into generated Codex configs — must be reachable by users |
| `WEB_ORIGIN` | no | `http://localhost:3000` | Comma-separated CORS allow-list for the dashboard |
| `PORT` / `HOST` | no | `4000` / `0.0.0.0` | Gateway bind address |
| `SESSION_TTL_HOURS` | no | `168` | Dashboard session lifetime |
| `COOKIE_SECURE` | no | `auto` | `auto` sets Secure when `PUBLIC_GATEWAY_URL` is https |
| `STRICT_ONE_TIME_KEYS` | no | `false` | Store user keys as a hash only — see [Security](#security) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | no | — | Bootstrap admin, created only when no admin exists |
| `LOG_LEVEL` | no | `info` | `fatal`…`trace` |
| `ENABLE_BACKGROUND_JOBS` | no | `true` | Health checks and the retention sweep |
| `HEALTH_CHECK_INTERVAL_MS` | no | `300000` | Pool health probe cadence |
| `RETENTION_SWEEP_INTERVAL_MS` | no | `21600000` | Log cleanup cadence |
| `GATEWAY_INTERNAL_URL` | no | `http://localhost:4000` | How the Next.js server reaches the gateway |

Runtime behaviour that admins change day to day — routing strategy, circuit
breaker thresholds, default rate limits, retention days, quota warning
percentage — lives in **Admin → Settings**, not in the environment.

---

## Connecting Codex CLI

Codex reads its configuration from `CODEX_HOME` (default `~/.codex`). The
**Connect Codex CLI** page generates it for the signed-in user's own key, in
either of two shapes.

### Dedicated provider (default)

Adds a provider block and keeps the key in an environment variable, so nothing
secret is written into the TOML file:

```toml
# ~/.codex/config.toml
model = "gpt-5-codex"
model_provider = "codex_gateway"

[model_providers.codex_gateway]
name = "Codex Gateway"
base_url = "https://gateway.example.com/v1"
env_key = "CODEX_GATEWAY_API_KEY"
wire_api = "chat"
```

The generated installer also appends the `export` line to the user's shell
profile, so "one button" still means one button.

### Override the built-in provider

Repoints the built-in `openai` provider and writes the key to `auth.json`, the
same shape `codex login --with-api-key` produces:

```toml
# ~/.codex/config.toml
model = "gpt-5-codex"
model_provider = "openai"
openai_base_url = "https://gateway.example.com/v1"
```

```json
// ~/.codex/auth.json
{ "OPENAI_API_KEY": "sk-cgw-…" }
```

Either way the page offers a **zip download** (`config.toml`, `auth.json` when
applicable, `install.sh`, `install.ps1`) and a **copyable one-line installer**
for bash or PowerShell. Both scripts create `CODEX_HOME` if needed and back up
any existing file to `<name>.bak.<timestamp>` before writing.

> **Two things worth knowing.** Provider and credential keys
> (`model_provider`, `model_providers`, `openai_base_url`) only take effect in
> the **user-level** config — Codex ignores them in a project-level config and
> warns. And these field names have changed between Codex releases: the
> generator is a single pure module (`packages/shared/src/codex-config.ts`)
> with full test coverage, so adapting to a rename is a one-line change.

---

## How quota is measured

Quota is a flat token number per key. There are no plans or tiers.

1. **Before forwarding** the gateway checks the key is active, unexpired, owned
   by an active user, within its rate limit, and has *some* quota left.
2. **After the response** it reads the provider's `usage` object — `prompt_tokens`
   /`completion_tokens` (Chat Completions) or `input_tokens`/`output_tokens`
   (Responses API) — and charges `total_tokens`.
3. **On a stream** the gateway injects `stream_options.include_usage` so the
   provider emits a final usage chunk, captures it, and — when the client did
   not ask for it — filters that chunk back out so the client sees exactly the
   stream it expected.
4. **If the provider reports nothing**, a local byte-based estimate is used and
   the row is marked `accuracy: "estimated"`. The UI labels those with `est`;
   they are never presented as exact.

Deduction is a relative `UPDATE … SET token_used = token_used + n`, so
concurrent requests cannot lose an update. Every change is mirrored into
`token_transactions`, making any balance reconstructable.

**A key can overshoot its grant by at most one request.** The cost of a request
is unknowable until the response arrives, so the gate is "has quota left", not
"has enough for this one". This is the standard pay-as-you-go trade-off and it
is visible in the dashboard as `used > granted`.

---

## Routing and failover

Each request builds an ordered list of eligible providers — active, circuit
closed, and serving the requested model — using the configured strategy:

| Strategy | Behaviour |
|---|---|
| `PRIORITY` | Lowest priority number first; healthier provider wins a tie |
| `ROUND_ROBIN` | Even rotation across eligible providers |
| `WEIGHTED` | Sampled proportionally to weight |

The gateway walks that list until one succeeds. Only **5xx, 408, 429 and
transport failures** count as provider failures and trigger the next attempt —
a 400 or 401 caused by the client is returned as-is, because retrying it
elsewhere would just repeat the rejection.

After `circuitThreshold` consecutive failures a provider's circuit opens for
`circuitCooldownSeconds` and it is skipped entirely. A successful health check
closes it early, so a recovered provider rejoins without waiting out the cooldown.

**Failover applies before the first byte only.** Once a stream has started
writing to the client, switching providers would corrupt it; the gateway emits
an SSE `error` event instead and still bills what was generated.

---

## Security

- **Upstream provider keys** are encrypted with AES-256-GCM (`v1:iv:tag:ciphertext`,
  fresh IV per record) and are never included in any API response — the UI only
  ever shows the last four characters.
- **User API keys** are 256 bits of CSPRNG output, looked up by SHA-256 digest.
  A fast hash is correct here: unlike a password there is nothing to guess, and
  the lookup is on the hot path of every proxied request.
- **Passwords** use scrypt (N=16384) with a per-password salt.
- **Sessions** are HMAC-SHA256 signed cookies (`httpOnly`, `SameSite=Lax`) backed
  by a `sessions` row, so revocation takes effect immediately. Changing a
  password or suspending a user deletes every session they have.
- **Rate limiting and concurrency caps** are enforced per key.
- **Header hygiene**: the client's `Authorization` and `Cookie` never reach an
  upstream, and an upstream's `Set-Cookie` and CORS headers never reach a client.
- **Error redaction**: every message that can reach a log, an audit row, or an
  API response passes through a secret-stripping filter first.
- **Audit trail** records every administrative action with actor, target, IP and
  a redacted payload.

### The one-time key trade-off

The Codex auto-setup page must emit a *working* config file, and a hash cannot
produce one. By default the gateway therefore also stores each user key
**encrypted** so the page keeps working after a restart. The "shown once" rule
is then a UI policy rather than a cryptographic guarantee — no read endpoint
ever returns a plaintext key.

Set `STRICT_ONE_TIME_KEYS=true` to store hashes only. Auto-setup then works
only in the session that issued the key; afterwards an admin must use
**Rotate** to mint a new secret. Choose based on whether your threat model
includes database-at-rest disclosure where `ENCRYPTION_KEY` is *not* also
compromised.

### Two-factor authentication

Not implemented. The schema reserves `users.totp_secret` for it. Until then,
put the dashboard behind your own SSO or network controls if admin 2FA is a
requirement.

---

## Operations

**Backups.** A nightly `pg_dump` profile is included, keeping the last 14
archives in `docker/backup/`:

```bash
docker compose --profile backup up -d
```

Restore with:

```bash
gunzip -c docker/backup/codex-gateway-<stamp>.sql.gz \
  | docker compose exec -T postgres psql -U codex -d codex_gateway
```

Back up `ENCRYPTION_KEY` separately and just as carefully — **a database dump
without it cannot yield provider credentials or user keys.**

**Retention.** Usage logs and audit entries older than `logRetentionDays`
(default 90) are deleted by a periodic sweep. Quota balances and token
transactions are never swept.

**Health.** `GET /api/health` reports gateway and database status; both
containers also declare Docker health checks.

**Scaling out.** See [Known limits](#known-limits) — rate limiting, concurrency
capping and the round-robin cursor are per-process today.

---

## API reference

### Gateway (Bearer `sk-cgw-…`)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/v1/chat/completions` | Chat Completions, streaming supported |
| `POST` | `/v1/responses` | Responses API, streaming supported |
| `GET` | `/v1/models` | Union of models the pool advertises |

Errors use the OpenAI envelope `{ "error": { message, type, code } }` with
codes `invalid_api_key`, `api_key_revoked`, `api_key_expired`,
`user_suspended`, `insufficient_quota`, `rate_limit_exceeded`,
`too_many_concurrent_requests`, `no_provider_available`, `upstream_error`.

### Dashboard (session cookie)

| Method | Path |
|---|---|
| `POST` | `/api/auth/login`, `/api/auth/logout`, `/api/auth/password` |
| `GET` | `/api/auth/me` |
| `GET`/`POST`/`PATCH`/`DELETE` | `/api/admin/users[/:id]` |
| `GET`/`POST` | `/api/admin/keys[/:id]`, `/api/admin/keys/:id/topup`, `/api/admin/keys/:id/rotate` |
| `GET`/`POST`/`PATCH`/`DELETE` | `/api/admin/providers[/:id]`, `/api/admin/providers/:id/test` |
| `GET` | `/api/admin/overview`, `/api/admin/logs`, `/api/admin/logs/export`, `/api/admin/audit` |
| `GET`/`PATCH` | `/api/admin/settings` |
| `GET` | `/api/me/dashboard`, `/api/me/logs`, `/api/me/logs/export`, `/api/me/sessions` |
| `GET` | `/api/me/codex-setup`, `/api/me/codex-setup/download` |

---

## Testing

```bash
npm test
```

138 tests covering the paths where a bug costs money or leaks a secret:

| Area | What is asserted |
|---|---|
| **Quota** (`tests/quota.test.ts`) | Deduction is order-independent, overshoot is bounded to one request, level thresholds, burn rate and runway projection, sliding-window rate limits, concurrency caps |
| **Routing** (`tests/router.test.ts`) | All three strategies, eligibility and model allow-lists, breaker opens at the threshold, client errors do not trigger failover, full failover walks |
| **Usage** (`tests/usage.test.ts`) | Both wire protocols, SSE framing across chunk boundaries, usage-only chunk detection, `include_usage` injection, cost calculation with cached tokens |
| **Codex config** (`tests/codex-config.test.ts`) | Both modes, TOML escaping, key never inlined in provider mode, backup and safety flags in the installers |
| **Installer** (`tests/install-script.test.ts`) | The generated bash **is executed** against a temp `CODEX_HOME`: files land correctly, existing ones are backed up, it is idempotent, and a key full of shell metacharacters survives byte-for-byte |
| **Security** (`tests/security.test.ts`) | AES-256-GCM round-trip and tamper rejection, password hashing, session token forgery, header stripping in both directions, secret redaction, zip structure |

The full stack was also verified end to end against a live PostgreSQL and two
stub upstream providers: 50 checks covering sign-in, RBAC, provider CRUD, key
issuance, streaming and non-streaming proxying, exact quota deduction,
failover, breaker opening, quota exhaustion, top-up, config generation and
revocation.

---

## Project layout

```text
apps/
  gateway/        Fastify — REST API, OpenAI-compatible proxy, background jobs
    src/lib/      crypto · api-key · usage · router · quota · rate-limit · upstream
    src/routes/   auth · admin · me · gateway
  web/            Next.js 15 App Router — /admin/* and /dashboard/*
packages/
  db/             Prisma schema, migrations, seed
  shared/         Zod contracts + the Codex config generator
  core/           Secret redaction, hashing, safe errors
  token-estimator/ Pricing and the estimation fallback
tests/            Vitest suites
docker/           Entrypoint, Caddyfile, backup volume
```

---

## Known limits

- **Single gateway instance.** Rate limiting, concurrency capping and the
  round-robin cursor are in-process. Running replicas multiplies the effective
  ceilings and makes rotation per-replica. Moving those three stores to Redis is
  the documented path to horizontal scale; nothing else in the design blocks it.
- **No 2FA yet** (see [Security](#security)).
- **Failover cannot recover a stream that already started.**
- **Estimated usage is approximate** — a byte-based heuristic, not a BPE
  tokenizer. It only applies when a provider reports no usage, and those rows
  are always labelled.

---

## Origins

This project began as **Local Token Monitor**, a privacy-first local dashboard
that *passively read* Codex and Claude Code session logs on one machine. It has
been converted into a multi-user gateway that *actively meters* traffic it
proxies. The analysis behind that conversion — what was kept, replaced, and
deleted, and why — is in [`docs/MIGRATION.md`](docs/MIGRATION.md). The
pre-conversion code remains in git history at commit `82cdb1d`.

## License

MIT — see [LICENSE](LICENSE).
