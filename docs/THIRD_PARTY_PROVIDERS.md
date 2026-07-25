# Third-party provider quota module

## Provider map

| Provider | Adapter | Default network | What can be shown | Remaining account quota |
|---|---|---|---|---|
| FreeModel | `freemodel` | Off | Public capabilities; observed OpenAI/Anthropic headers and usage | Unavailable until an official quota endpoint is verified |
| NTTCodex | `nttcodex` | Off | Public domain/base-URL evidence; observed compatible headers/body after protocol confirmation | Unavailable until an official quota endpoint is verified |
| Generic OpenAI-compatible | `openai-compatible` | Off | OpenAI rate-limit headers and response usage | Only when explicitly returned by a configured endpoint/header |
| Generic Anthropic-compatible | `anthropic-compatible` | Off | Anthropic rate-limit headers and response usage | Only when explicitly returned by a configured endpoint/header |

Read the evidence and limitations in [THIRD_PARTY_PROVIDER_RESEARCH.md](THIRD_PARTY_PROVIDER_RESEARCH.md).

## Normalized snapshot

`ProviderQuotaSnapshot` contains:

- provider ID, protocol, status, timestamp, endpoint;
- zero or more typed metrics with `limit`, `used`, `remaining`, unit, window, and reset time;
- evidence entries with source kind, official flag, URL, and observation time;
- confidence, `partial`, warnings, sanitized error, HTTP status, and `Retry-After`;
- no prompt, response content, cookie, authorization header, or credential.

Statuses are deliberately strict:

- `available`: recognized rate-limit values are present;
- `partial`: valid usage exists, but it does not establish remaining account quota;
- `unavailable`: no defensible value or network is disabled;
- `unverified`: the provider/domain contract is not confirmed;
- `error`: a safe explicit request failed.

## Safe discovery levels

| Level | Action | Default |
|---|---|---|
| 0 | Bundled public homepage/docs/policy research | Yes |
| 1 | Public, non-billing endpoint checks | Not executed automatically |
| 2 | Authenticated GET to a documented quota endpoint | Requires explicit endpoint, environment credential, and network opt-in |
| 3 | Dashboard automation | Disabled; requires provider permission and a separate reviewed implementation |

The current CLI and dashboard execute Level 0 for `discover`. They report a higher requested level but do not silently escalate.

## CLI

With a local checkout:

```bash
npm run build
node dist/cli.js provider discover freemodel
node dist/cli.js provider discover nttcodex
node dist/cli.js provider status
node dist/cli.js provider test freemodel
```

With the public one-command build:

```bash
npx --yes github:phucthinhvn122/local-token-monitor provider discover freemodel
```

`provider test` sends no request unless all of these are true:

1. `--allow-network` is present;
2. an explicit HTTPS GET quota endpoint is configured;
3. the named environment variable exists when authentication is required.

Example for a provider that has published a read-only quota endpoint:

```bash
node dist/cli.js provider test openai-compatible \
  --endpoint=https://provider.example/v1/quota \
  --protocol=openai \
  --api-key-env=PROVIDER_API_KEY \
  --allow-network
```

Never substitute an inference endpoint just to obtain rate-limit headers; it may consume tokens or money.

## Supplying a credential without echo or persistence

PowerShell:

```powershell
$env:PROVIDER_API_KEY = [System.Net.NetworkCredential]::new("", (Read-Host "API key" -AsSecureString)).Password
node dist/cli.js provider test openai-compatible --endpoint=https://provider.example/v1/quota --protocol=openai --api-key-env=PROVIDER_API_KEY --allow-network
Remove-Item Env:PROVIDER_API_KEY
```

Bash/zsh:

```bash
read -rsp "API key: " PROVIDER_API_KEY
export PROVIDER_API_KEY
node dist/cli.js provider test openai-compatible --endpoint=https://provider.example/v1/quota --protocol=openai --api-key-env=PROVIDER_API_KEY --allow-network
unset PROVIDER_API_KEY
```

The dashboard stores only the environment variable name. Restart the local server after setting an environment variable so the server process inherits it.
Enable **Settings → Provider network** for dashboard-initiated manual refreshes, or set `LTM_PROVIDER_NETWORK=true` before starting the server. This is separate from non-loopback server binding.

## Manual endpoint confirmation

Use this only on your own account and only when the provider permits it:

1. Open the provider dashboard normally.
2. In browser DevTools, open **Network**, filter to **Fetch/XHR**, and manually refresh the provider's own quota view once.
3. Record only the request URL, HTTP method, response content type, and JSON field names.
4. Confirm it is a read-only `GET`, is documented or clearly used by the provider's own quota page, and does not trigger inference or billing.
5. Do not copy cookies, authorization values, request bodies, HAR files, local storage, or response data containing personal information.
6. If the value exists only in rendered HTML or the endpoint contract is unclear, stop and leave the provider `Unavailable`.

The module never imports a cookie value. For NTTCodex, the optional **Connect browser** action opens a dedicated visible Chrome/Edge/Chromium profile. You sign in on the provider page, and same-origin code reads only `GET /account/keys`. Raw account responses, API key values, cookie values, and passwords are discarded; only aggregate quota metrics enter SQLite. Keep that browser window open for the 30-second live refresh, or click **Disconnect** to close it.

## Network and failure behavior

- HTTPS only; embedded credentials, query strings, loopback, and obvious private-network targets are rejected.
- Redirects are rejected.
- Generic provider endpoints are manual-refresh only. The explicitly connected NTTCodex browser bridge refreshes every 30 seconds while its dedicated window is open.
- DNS is resolved before a real request and private/reserved results are rejected to reduce SSRF and DNS-rebinding risk.
- Response bodies are capped at 1 MB.
- `401`/`403` stops immediately without retry.
- `429` records `Retry-After`; the server rejects refresh attempts until that time.
- Non-JSON bodies are discarded.
- Unknown schemas and missing/negative values produce `Unavailable`, not fabricated zeroes.
- API keys and authorization headers are redacted from server logs and never serialized into snapshots.

## Permissions

| Resource | Access |
|---|---|
| Public provider pages | Read-only Level 0 research |
| Configured quota endpoint | One explicit HTTPS `GET` after opt-in |
| API key | Read from named process environment variable only |
| Provider cookies/session | Managed by the dedicated browser profile; cookie values are never read or serialized by the monitor |
| Provider dashboard DOM | No automation |
| SQLite | Provider metadata and sanitized snapshots only |
| Browser storage | NTTCodex session remains in the dedicated local browser profile; provider snapshots are not stored there |

## Validation

Fixtures cover OpenAI and Anthropic headers, multiple reset formats, missing and negative fields, JSON and SSE usage, 401/403/429, `Retry-After`, HTML responses, malformed/changed schemas, total-token double counting, disabled network, and secret leakage. Run:

```bash
npm test
npm run typecheck
npm run build
```
