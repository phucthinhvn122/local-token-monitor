# Architecture

## Design goals

Local Token Monitor is a loopback-only observability application. Collection failures must never stop the API, unsupported records must never be guessed, and content not needed for token usage must never reach persistent storage.

```text
Provider paths + read-only processes
              │
      Codex / Claude adapters
              │ known usage fields only
        Collector Manager
              │ normalize · redact · dedupe
        SQLite repository
              │ aggregate
      Fastify REST + local SSE
              │
         React dashboard
```

## Workspace tree

```text
apps/
  server/                 Fastify API, SSE, CLI
  web/                    React/Vite dashboard
packages/
  core/                   normalization, process scan, project resolver, redaction
  database/               SQLite repository, migration, demo seed, pricing
  collectors/             resilient JSONL parser, watcher, collector manager
  provider-codex/         Codex installation/source/session adapter
  provider-claude/        Claude Code installation/source/session adapter
  provider-quota/         third-party research, header/body parsers, safe GET adapter
  shared-types/           Zod schemas and stable interfaces
  token-estimator/        optional local fallback and pricing calculation
tests/
  fixtures/               synthetic, secret-free provider records
```

## Database schema

- `providers`: installation/version status.
- `projects`: resolved identity, optional Git metadata, hidden/demo state.
- `sessions`: provider, project, model, process, timestamps, state.
- `token_usage_events`: normalized token fields, accuracy/source, pricing, fingerprint, demo state.
- `collector_sources`: hashed source identity, parser version, offset/error metadata.
- `model_pricing`: editable local pricing patterns and effective dates.
- `settings`: JSON values for local configuration.
- `ignored_projects`: hidden projects.
- `aliases`: user-defined display names.
- `third_party_provider_configs`: public URL/protocol policy and API-key environment-variable name; never the key value.
- `provider_quota_snapshots`: normalized, sanitized quota/header snapshots.

Indexes cover event timestamp, provider, project, session, and session/project relationships. Foreign keys and WAL are enabled. Demo rows carry `is_demo=1` and API queries select exactly one data mode.

## Discovery

### Codex

The adapter locates the executable with the operating system command resolver, obtains `--version`, matches native or Node-wrapped processes, and checks candidate roots under `CODEX_HOME`, `~/.codex`, and platform data directories. It does not depend on one fixed path.

### Claude Code

The adapter uses the same binary/process strategy and checks `~/.claude/projects`, `~/.claude/sessions`, platform configuration/data roots, and user-supplied paths.

Both adapters consider only recent `.json`/`.jsonl` candidates, ignore `.env`, cap discovery, and expose checked/found paths through redacted diagnostics.

### Third-party quota

FreeModel and NTTCodex use bundled Level 0 research. Generic OpenAI/Anthropic adapters parse only recognized rate-limit headers and response usage objects. Direct fetching requires an explicit HTTPS quota endpoint, environment-based credential, and network opt-in. There is no authenticated dashboard scraping, cookie reuse, or automatic inference request.

## Accuracy and totals

- **Exact**: provider supplied an authoritative total or direct usage metadata.
- **Derived**: total is input + output from exact component fields.
- **Estimated**: local tokenizer/heuristic fallback, disabled by default.
- **Unavailable**: no defensible token value.

If a provider supplies `total_tokens`, it wins. Cache and reasoning fields remain separate dimensions and are not added again. Cumulative Codex counters are converted to non-negative deltas per session before persistence.

## Project resolution

Candidate priority is process CWD, Git root, workspace root, session path metadata, parent CWD, then basename. Git commands are read-only. When OS permissions block process CWD and session metadata has no workspace, the session stays unresolved.

## Failure isolation

Every parser is versioned. Malformed lines and unknown fields are ignored; sanitized errors are retained only in diagnostics. Fingerprint uniqueness makes rescans idempotent. Watcher/parser errors become activity events rather than unhandled server failures.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Provider format changes | Versioned parsers, schema validation, fixtures, graceful skip |
| Cumulative usage double count | Delta tracking plus fingerprint uniqueness |
| Secret in error/command | Pattern redaction and Fastify header redaction |
| Excessive local scan | Recent-file window, source cap, explicit candidate roots |
| Incorrect pricing | Separate editable table, effective date, “Estimated Cost” label |
| Network exposure | Force `127.0.0.1` unless an explicit setting and environment opt-in |
