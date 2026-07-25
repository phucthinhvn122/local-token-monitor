# Privacy

Local Token Monitor is designed to work without a cloud service.

## Data collected

The application may store provider name, model name, token counters, accuracy/source labels, timestamps, session identifiers, project metadata, collector status, and estimated cost. Demo data is marked and queried separately from real data.

## Data never stored

Prompts, model responses, source code, file contents unrelated to supported usage metadata, `.env` contents, API keys, authorization headers, cookies, and raw unredacted command lines are not persisted.

Third-party provider configuration stores only public URLs, protocol selection, refresh policy, and the **name** of an environment variable. The variable's value is read only by the server process for an explicitly authorized request and is never returned to the browser or written to SQLite. Authenticated dashboard cookies, local storage, and HAR files are never imported.

Session files are parsed locally in memory. Only known usage and safe metadata fields are selected. Unknown fields are discarded. The application has no telemetry, analytics, cloud sync, automatic crash reporting, or automatic pricing requests.

## Privacy Mode

Privacy Mode masks full project paths, Git remotes, operating-system usernames, database paths in diagnostics, and full session identifiers in the UI.

## Control and retention

Data is stored in a local SQLite database under the user profile by default. Retention defaults to 90 days for real usage events. Settings includes JSON/CSV export and a confirmed local reset. Demo records can be regenerated and are never mixed into live queries.

Non-loopback binding is disabled unless the user explicitly enables it. Doing so changes the threat model and should be combined with host firewall controls.

Outbound provider access is also disabled by default and has a separate setting from non-loopback server binding. Public Level 0 discovery is bundled research, not a live authenticated request. A manual provider refresh requires network opt-in and an explicit HTTPS quota endpoint.
