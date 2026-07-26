# Architecture

## Design goals

1. **A request is never billed wrong.** Quota deduction is atomic, sourced from
   the provider's own numbers where possible, and clearly labelled when it is not.
2. **A pool credential never escapes.** Encrypted at rest, decrypted only for the
   single outbound call, stripped from every response and log line.
3. **A pool failure is not a user failure.** Failover and a circuit breaker keep
   the gateway serving while individual upstreams misbehave.
4. **Setup is two clicks.** The Codex configuration a user needs is generated,
   not documented.

```text
Codex CLI ──Bearer sk-cgw-…──▶ Fastify gateway ──▶ pool provider ──▶ upstream model
                                    │
                          authenticate · quota · rate limit
                          route · forward · measure · charge
                                    │
                              PostgreSQL (Prisma)
                                    ▲
                          Next.js dashboard (session cookie)
```

## Workspace

```text
apps/
  gateway/          Fastify: /api/* dashboard API + /v1/* OpenAI-compatible proxy
    src/env.ts      Zod-validated configuration; refuses to boot when invalid
    src/server.ts   Plugin/route assembly, error handler, bootstrap admin
    src/jobs.ts     Health checks, retention sweep, rate-limit state sweep
    src/lib/
      crypto        AES-256-GCM, scrypt passwords, HS256 session tokens
      api-key       Generation, hashing, masking, bearer parsing
      usage         Wire-protocol usage normalisation, SSE parsing
      router        Selection strategies, eligibility, circuit breaker rules
      quota         Admission check, atomic charge, burn rate, projection
      rate-limit    Sliding window + concurrency slots (in-process)
      upstream      Outbound call and reachability probe
      stats         date_trunc rollups and bucket filling
      http          Error types, header allow/deny lists
      audit         Redacted administrative logging
      settings      Cached settings and pricing
    src/routes/     auth · admin · me · gateway
  web/              Next.js 15 App Router
    app/admin/*     Overview, users, keys, providers, logs, audit, settings
    app/dashboard/* Overview, connect, logs, account
    components/     ui · charts · shell · auth-provider · log-table
packages/
  db/               Prisma schema, migrations, seed
  shared/           Zod contracts + Codex config generator
  core/             Redaction, hashing, safe errors
  token-estimator/  Pricing and estimation fallback
```

## Request pipeline

For `POST /v1/chat/completions` and `POST /v1/responses`:

1. **Authenticate** — SHA-256 the bearer token, single indexed lookup. Reject
   unknown, revoked, expired, or suspended-owner keys with an OpenAI-shaped error.
2. **Rate limit** — per-key sliding 60s window, then a concurrency slot. Both fall
   back to system defaults when the key sets `0`.
3. **Admit on quota** — "has any quota left", not "has enough for this one".
4. **Order providers** — filter to active, circuit-closed, model-serving
   providers, then order by the configured strategy.
5. **Forward** — strip the client's `Authorization`/`Cookie`, attach the decrypted
   pool credential, `JSON.stringify` the body. On 5xx/408/429/transport failure,
   record the failure and try the next provider. On a client 4xx, return it.
6. **Measure**
   - *Buffered*: read `usage` from the body.
   - *Streamed*: hijack the socket, parse SSE incrementally, capture the usage
     chunk, and drop it from the client stream if the client never asked for it.
   - *Neither*: estimate locally and mark `accuracy: "estimated"`.
7. **Settle** — write `usage_logs`, then `token_used += total`, plus a `DEDUCT`
   transaction. Detached from the response so a database hiccup cannot turn a
   successful completion into an error.

## Concurrency and correctness

- **Quota** uses `{ increment }`, never read-modify-write, so interleaved
  requests cannot lose an update.
- **Key creation** runs in a transaction with optional user creation, so a
  duplicate email cannot leave an orphaned key.
- **Settlement is idempotent per request** — one log row, one deduction.
- **Session validity** is a database row, not just a signature, so revocation is
  immediate.

## Accuracy labelling

| Label | Meaning |
|---|---|
| `exact` | The provider returned a `usage` object |
| `estimated` | No provider usage; local byte heuristic, shown as `est` in the UI |

`total_tokens` from the provider always wins over the component sum, because
some providers bill components they do not itemise.

## Failure isolation

| Failure | Behaviour |
|---|---|
| One provider 5xx / timeout | Failover to the next; error counted |
| N consecutive failures | Circuit opens for the cooldown; provider skipped |
| Provider recovers | A passing health check closes the circuit early |
| Every provider fails | `502` with the last error, logged with `provider_id = null` |
| Client 4xx from upstream | Returned unchanged, no failover, provider not blamed |
| Stream breaks mid-flight | SSE `error` event, usage so far still billed |
| Client disconnects | Upstream read cancelled, usage so far still billed |
| Database write fails at settle | Logged; the client keeps its successful response |

## Known boundaries

- **Single instance.** Rate limiting, concurrency capping and the round-robin
  cursor are per-process. Redis is the documented path to replicas.
- **One-request overshoot** on quota, by design.
- **No failover after first byte** on a stream.
- **No 2FA**; `users.totp_secret` is reserved.
