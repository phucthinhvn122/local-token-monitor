# Security Policy

## Supported versions

Security fixes are provided for the latest minor release while the project is pre-1.0.

## Reporting a vulnerability

Please use GitHub private vulnerability reporting when the repository is published. Do not include real API keys, session files, prompts, source code, or unredacted diagnostic reports. A maintainer should acknowledge a complete report within seven days.

## Security model

- The server forces `127.0.0.1` unless both local configuration and environment opt in to network access.
- There is no telemetry, third-party analytics, cloud upload, or automatic crash reporting.
- Request authorization, cookies, and API-key headers are redacted from server logs.
- Third-party API secrets are accepted only through a named environment variable; the browser never receives the secret value.
- The optional NTTCodex browser bridge uses a dedicated visible browser profile and same-origin `GET /account/keys`; the monitor never reads cookie values, passwords, or API key values from the response.
- Provider quota requests are manual HTTPS `GET` requests. Redirects, query strings, embedded credentials, loopback, and obvious private-network targets are rejected.
- Authentication failures stop without retry; `429 Retry-After` creates a refresh cooldown.
- Provider processes are read-only: the scanner never kills, pauses, injects, or modifies them.
- `.env`, repository source trees, and arbitrary home-directory traversal are outside collector discovery.
- Parser errors and diagnostic paths pass through secret and username redaction.
- SQLite uses foreign keys, WAL, parameterized statements, and a unique event fingerprint.

Custom log paths expand what the application can read. Add only trusted, minimal directories.

Custom quota endpoints expand outbound network access. Configure only a provider-documented, read-only endpoint. Never use an inference endpoint merely to sample rate-limit headers, and never paste cookies or dashboard session tokens. The dedicated NTTCodex browser profile is local state; sign out in that window or use **Disconnect** when you no longer want it active.
