# Migration analysis: Local Token Monitor → Codex Gateway

This document is the "what was there, what it became, and why" record for the
conversion. The pre-conversion tree is preserved in git history at commit
`82cdb1d`.

---

## 1. What the original source was

**Local Token Monitor** was a single-machine, privacy-first observability tool.
It did not sit in the request path of anything: it *watched* the files Codex CLI
and Claude Code leave behind and reported on them.

| Property | Value |
|---|---|
| Runtime | Node 22, TypeScript, npm workspaces |
| Backend | Fastify 5, Zod, SSE, ~551 lines in one route file |
| Frontend | React 19 + Vite, 996 lines in a single `main.tsx`, hand-written CSS, no router |
| Database | `node:sqlite` accessed with hand-written SQL; migrations replayed as raw `.sql` files |
| Distribution | An npm binary (`npx local-token-monitor`) that started a loopback server and opened a browser |
| Extras | A separate Next.js "public relay" app using Drizzle, and a Playwright browser bridge for scraping one provider's quota page |

### The architectural inversion

The original codebase was built around three commitments that the gateway
requirement reverses outright:

| Original commitment | Where it was enforced | Gateway requirement |
|---|---|---|
| Loopback only | Server forced `host = "127.0.0.1"` unless an explicit opt-in | Must be publicly reachable |
| Network off by default | A Zod refinement *rejected* private-IP and non-HTTPS provider URLs; fetching required an opt-in flag | Must forward every request to upstreams, some on a private Docker network |
| Single implicit user | No `users` table, no auth, no sessions, no roles | Multi-tenant with admin/user roles and per-key metering |
| Passive observation | Collectors tailing JSONL with `chokidar`, deduplicating by fingerprint | Active proxy that measures authoritatively |

This is why the conversion is a rewrite rather than an extension. Roughly **15%
of the original code carried over.**

---

## 2. Disposition of every original component

### Kept and adapted

| Component | Original | Now | Why it survived |
|---|---|---|---|
| `packages/core` | 220 lines: redaction, fingerprinting, process scanning, project resolution | ~60 lines: `redactSecrets`, `safeError`, `sha256`, `toTokenCount` | The secret-redaction patterns are *more* important in a gateway that holds upstream credentials. Process/project code had no meaning without local collectors. |
| `packages/token-estimator` | `estimateTokens`, `calculateCost` | Same two jobs, plus `extractRequestText` for both wire protocols and longest-pattern pricing match | Exactly the fallback the gateway needs when a provider omits `usage`. |
| Zod-contract pattern | `packages/shared-types` | `packages/shared` | The discipline of one schema module shared by both ends was worth keeping; the schemas themselves are all new. |
| Fastify + error handler + header redaction | `apps/server` | `apps/gateway` | Fastify's `reply.hijack()` is exactly right for pass-through SSE. The logger redaction config carried over verbatim. |
| Monorepo shape | npm workspaces, `@ltm/*` | npm workspaces, `@cgw/*` | Worked; no reason to change it. |
| React/Recharts/lucide | `apps/web` (Vite) | `apps/web` (Next.js) | The libraries stayed; the 996-line single file did not. |

**A real bug came across with the redaction code and was caught by a new test.**
The `sk-` pattern used a capturing group, and the shared replacer treats group 1
as a field *label* to preserve — so redacting `sk-abcdef1234567890` produced
`sk-abcdef1234567890=[REDACTED]`, echoing the key it was meant to remove. Fixed
by making the group non-capturing (`packages/core/src/index.ts`).

### Replaced

| Component | Replaced by | Reason |
|---|---|---|
| `packages/database` (607 lines of hand-written SQLite) | `packages/db` — Prisma + PostgreSQL | SQLite serialises writes. A gateway charging quota on every concurrent request needs real MVCC and a relative `UPDATE … increment`. Prisma also gives typed migrations instead of replayed `.sql`. |
| `apps/web` single-file React | Next.js 15 App Router, routed `/admin/*` and `/dashboard/*` | Two role areas, deep-linkable pages, and per-page code splitting. |
| Ad-hoc CSS | Tailwind v4 with an oklch token layer | Dark default plus light toggle, and one accent used consistently. |
| Aggregation in JS (`timeline()` looped over every row in memory) | `date_trunc` rollups in Postgres | The log table is the one that grows without bound; pulling 90 days of rows into the process to bucket them is the first thing that would fall over. |

### Deleted

| Component | Lines | Reason |
|---|---|---|
| `packages/collectors` | 449 | Tailing local JSONL is meaningless when the gateway measures usage authoritatively at the proxy. |
| `packages/provider-codex`, `provider-claude` | 322 | Detecting locally installed CLIs is not a server concern. |
| `packages/provider-quota` | 2,018 | Third-party quota scraping — including a Playwright browser bridge that drove a signed-in session — is entirely superseded by health checks against providers the operator owns. |
| `apps/public-relay` | Next.js + Drizzle app | Published a read-only public quota page; the authenticated dashboard covers it. |
| `apps/server` route file | 551 | Every endpoint was about local collectors or third-party quota. |
| CLI (`cli.ts`), `tsup` npm-binary packaging | 342 | The product is a deployed service now, not an `npx` command. |

Deleting the npm-binary product surface is the one genuinely lossy part of this
conversion. It was the right call for the stated goal, and the code is recoverable
from history if that surface is ever wanted back.

---

## 3. Target architecture

| Layer | Choice | Rationale |
|---|---|---|
| Gateway | Fastify 5 | Already present, minimal overhead, and `reply.hijack()` gives byte-level control of a streamed response — which the usage-chunk filtering depends on. |
| Dashboard | Next.js 15 App Router | Proxies `/api/*` to the gateway, keeping the session cookie first-party and the gateway off the browser's network path. |
| Database | PostgreSQL 17 + Prisma 6 | Concurrent writes, `date_trunc` rollups, typed migrations. |
| Rate limit / breaker state | In-process | Redis was explicitly descoped. The three affected stores are isolated behind small modules and documented as the horizontal-scaling boundary. |
| Deployment | Docker Compose | Long-lived streaming connections rule out most serverless platforms. |

### Data model

Nine tables, all new: `users`, `sessions`, `api_keys`, `token_transactions`,
`pool_providers`, `usage_logs`, `admin_audit_logs`, `model_pricing`,
`system_settings`. Full definitions in `packages/db/prisma/schema.prisma`; the
initial migration is `packages/db/prisma/migrations/20260101000000_init/`.

Three decisions worth calling out:

1. **`api_keys.token_used` is the single source of truth**, mutated only by
   relative increments. `token_transactions` is the audit ledger that makes any
   balance reconstructable, not the balance itself.
2. **`api_keys.key_encrypted` exists alongside `key_hash`.** The Codex
   auto-setup page must emit a working config, which a hash cannot produce.
   `STRICT_ONE_TIME_KEYS=true` leaves the column null for operators who prefer
   the stronger guarantee. Discussed in the README's Security section.
3. **`system_settings` is a singleton row**, so routing strategy and breaker
   thresholds are editable at runtime rather than baked into the environment.

---

## 4. Open questions resolved before coding

Four decisions were put to the project owner because each changed the shape of
the work:

| Question | Decision |
|---|---|
| Backend and database | Fastify + Prisma/PostgreSQL, with Next.js as a separate frontend |
| Deployment target | VPS with Docker Compose |
| Codex CLI config approach | Generate **both**, defaulting to the dedicated-provider form |
| Gateway scope | Streaming SSE **and** both wire APIs; **Redis declined**; **2FA declined** |

The two declines are reflected honestly in the build: rate limiting is
in-process and documented as single-instance, and `users.totp_secret` is
reserved in the schema but unused.

---

## 5. Questions still open

None block use of the system. Each is a judgement call an operator may want to revisit:

1. **Horizontal scale.** If more than one gateway replica is ever needed, the
   in-process rate limiter, concurrency counter and round-robin cursor must move
   to Redis. Nothing else in the design blocks it.
2. **Admin 2FA.** *(Since resolved.)* TOTP enrolment now ships in Account
   settings, with a rate-limited login challenge and a two-factor disable flow.
3. **Key storage posture.** `STRICT_ONE_TIME_KEYS` defaults to `false` so
   auto-setup keeps working after a restart. Operators whose threat model
   includes database disclosure without key disclosure should flip it and rely
   on **Rotate**.
4. **Pricing accuracy.** Seeded rates are current published list prices and are
   editable in the database, but nothing refreshes them automatically. Costs are
   labelled "estimated" throughout.
5. **Codex CLI field drift.** Provider/credential key names have changed across
   Codex releases. The generator is one pure, fully tested module
   (`packages/shared/src/codex-config.ts`) precisely so a rename is a one-line,
   verifiable change — but it should be checked against the CLI version your team
   actually runs.
