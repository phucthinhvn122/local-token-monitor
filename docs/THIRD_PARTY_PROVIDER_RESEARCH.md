# Third-party provider research

Research date: 2026-07-25 (Asia/Saigon)

This report records only public, reproducible evidence. No account was created, no authenticated dashboard was opened, no API key was used, and no inference request was sent. DNS and HTTPS checks were limited to the named public domains.

## Classification model

The module keeps these concepts separate:

| Concept | Meaning | Safe source |
|---|---|---|
| Observed token usage | Tokens consumed by a completed request | Known OpenAI/Anthropic response `usage` object |
| Context usage | Tokens occupying a model context window | Explicit provider field or local calculation, clearly labeled |
| Rate-limit headroom | Requests/tokens available in the current rate window | Provider response headers |
| Account credit | Currency or credits still available | Documented authenticated account API |
| Subscription quota | Plan allowance remaining over a day/month/package | Documented authenticated quota API |

Rate-limit headroom is never presented as account credit or subscription quota. A request usage total is never subtracted from an undocumented plan limit.

## `freemodel.dev`

| Item | Finding | Confidence |
|---|---|---|
| Domain | DNS resolves; `https://freemodel.dev/` returned HTTP 200 | High |
| Product | Multi-model API gateway | High |
| Public base URL | `https://api.freemodel.dev/v1` | High |
| Protocol | OpenAI and Anthropic compatible | High |
| Public inference endpoints | `POST /v1/responses`, `POST /v1/chat/completions`, `POST /v1/messages` | High |
| Authentication | API key generated in the dashboard | High |
| Usage dashboard | Public privacy policy says token-count request metadata powers a usage dashboard | High |
| Rate limits / plan quota | Terms say plans are subject to rate limits and quotas | High |
| Public quota/balance API | Not found in Level 0 research | None |
| Public repository | No official repository link was verified | None |
| Dashboard automation | Scraping/circumvention is prohibited; no explicit dashboard automation permission was found | High for restriction, none for permission |

Official evidence:

- [FreeModel product and API page](https://freemodel.dev/)
- [FreeModel privacy policy](https://freemodel.dev/privacy)
- [FreeModel terms of service](https://freemodel.dev/terms)

Implementation decision: the bundled adapter knows the documented base URL and inference formats but has no direct quota endpoint. It therefore returns `Unavailable` for remaining credits/quota and sends no request. It can parse recognized rate-limit headers and usage bodies obtained from legitimate provider responses.

## `nttcodex.com`

| Item | Finding | Confidence |
|---|---|---|
| Domain | DNS resolves; `https://nttcodex.com/` returned HTTP 200 | High |
| Product | Public site describes API keys, package quota, token history, and per-request usage | High |
| Public base URL | Public guide page configuration contains `https://nttcodex.com/v1` | Medium |
| Protocol | No public protocol specification was verified | None |
| Public inference endpoints | No specific endpoint was verified | None |
| Authentication | The public site describes user-created API keys | High |
| Usage/quota dashboard | Public navigation and product copy describe quota and token history | High |
| Public quota/balance API | Not found in Level 0 research | None |
| Public repository | Not found | None |
| Terms/privacy/automation | No public policy that authorizes dashboard automation was verified | None |

Official evidence:

- [NTTCodex public site](https://nttcodex.com/)
- [NTTCodex public usage guide](https://nttcodex.com/user/huong-dan)

Implementation decision: the domain is verified, but the protocol and quota endpoint remain unverified. The bundled adapter does not guess `/quota`, scrape `/user/quota`, reuse browser cookies, or send an inference request. Remaining quota is `Unavailable` until a documented endpoint is supplied by the provider or explicitly configured by the user.

## Generic compatibility evidence

The OpenAI API documents `x-ratelimit-limit-*`, `x-ratelimit-remaining-*`, and `x-ratelimit-reset-*` response headers. Anthropic documents request, combined-token, input-token, and output-token rate-limit headers plus `Retry-After`.

- [OpenAI API debugging and rate-limit headers](https://platform.openai.com/docs/api-reference/debugging-requests)
- [Anthropic rate-limit response headers](https://platform.claude.com/docs/en/api/rate-limits)

These conventions are implemented only as parsers. A third-party provider is marked `official-header` only when the exact recognized headers are observed in its response; compatibility alone does not prove an account balance.

## Assumptions and unavailable data

- Search-engine snippets and third-party resellers were not used to establish provider endpoints or quota numbers.
- A link visible in public HTML is not treated as a public API contract.
- An authenticated web dashboard is not scraped.
- Browser cookies, session tokens, HAR files, and local storage are not imported.
- No automatic request is made merely to obtain headers, because an inference request may consume quota or money.
- All findings can change. The evidence date and source remain attached so future updates can be audited.
