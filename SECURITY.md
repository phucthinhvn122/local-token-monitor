# Security Policy

## Supported versions

Security fixes are provided for the latest minor release while the project is pre-1.0.

## Reporting a vulnerability

Please use GitHub private vulnerability reporting when the repository is published. Do not include real API keys, session files, prompts, source code, or unredacted diagnostic reports. A maintainer should acknowledge a complete report within seven days.

## Security model

- The server forces `127.0.0.1` unless both local configuration and environment opt in to network access.
- There is no telemetry, third-party analytics, cloud upload, or automatic crash reporting.
- Request authorization, cookies, and API-key headers are redacted from server logs.
- Provider processes are read-only: the scanner never kills, pauses, injects, or modifies them.
- `.env`, repository source trees, and arbitrary home-directory traversal are outside collector discovery.
- Parser errors and diagnostic paths pass through secret and username redaction.
- SQLite uses foreign keys, WAL, parameterized statements, and a unique event fingerprint.

Custom log paths expand what the application can read. Add only trusted, minimal directories.
