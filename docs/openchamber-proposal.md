# Proposal: quota providers for Alibaba Cloud Model Studio Token Plan and Xiaomi MiMo Token Plan

## Why

Settings → Usage covers a fixed provider registry. The two subscription plans below are popular with OpenCode users (both ship as built-in OpenCode providers, `alibaba-token-plan` and `xiaomi-token-plan-ams`), but neither appears on the Usage page. This is **not** a revival of the generic quota-config request in #2327 — it is the bespoke-module path that issue's discussion identified as the appropriate one for known providers: two small modules in `server/lib/quota/providers/`, following the pattern of the existing 25.

A working implementation exists today as an OpenChamber extension (panel + local service), so every payload shape below is verified against the live APIs: https://github.com/Edigorin/openchamber-token-plan-usage

## What each provider reports

Both report **provider-side plan quota** (the philosophy the Usage page already follows — plan names, quota windows, reset times; no estimated billing).

### `alibaba-token-plan` — Alibaba Cloud Model Studio (Token Plan)

Console gateway (via `zeldaEasy`/`zeldaHttp` console APIs):

| Purpose | API | Payload (redacted) |
| --- | --- | --- |
| Monthly quota | `zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage` | `{"per1MonthPercentage": 1, "per1MonthResetTime": 1794153600000}` (percentage is a **used fraction** 0..1; reset is epoch ms) |
| Quota add-ons ("加量包" / boost packs) | `…/addon/list` | `{"items":[{"addonTier":"extrabundle","remainingCredits":18765.3,"totalCredits":20000,"remainingDays":31,"startTime":…,"endTime":…,"status":"ACTIVE"}]}` |
| Add-on aggregate | `…/addon/summary` | `{"remainingCredits":18765.3,"activeCount":1,"totalCredits":20000,"nearestExpireTime":…}` |

Mapping: monthly fraction → one window (`usedPercent`, `resetAt`, label "Monthly quota"); each active add-on → a window (`usedPercent` from `1 - remainingCredits/totalCredits`, `resetAt` = `endTime`, value label `credits used / total`). Add-on packs matter in practice: a user whose monthly quota is 100 % consumed keeps working from the pack.

**Auth reality (tested 2026-10-14):** the plan API key cannot read these endpoints — the inference gateway 404s `/tokenplan/personal/…` and the console gateway requires a console access token (Alibaba Cloud session, obtained by `bl auth login --console` and stored by the Bailian CLI as `access_token`). Suggested managed credential field: `consoleToken`.

### `xiaomi-token-plan-ams` — Xiaomi MiMo Token Plan

`https://platform.xiaomimimo.com/api/v1` (the same calls the plan page itself makes):

| Purpose | API | Payload (redacted) |
| --- | --- | --- |
| Plan + period | `GET /tokenPlan/detail` | `{"data":{"planCode":"lite","planName":"Lite","currentPeriodEnd":"2026-11-14 23:59:59","expired":false,"enableAutoRenew":true}}` |
| Credit usage | `GET /tokenPlan/usage` | `{"data":{"monthUsage":{"percent":0.51,"items":[{"name":"month_total_token","used":…,"limit":…,"percent":0.51}]}}}` (percent is a used fraction 0..1) |
| Balance (pay-as-you-go only) | `GET /balance` | `{"data":{"balance":"0.00","currency":"USD",…}}` — optional; subscription accounts have none |

Mapping: `monthUsage.items[]` → windows (`usedPercent`, `resetAt` = `currentPeriodEnd`, value label `credits used / total`), `planName` as `planLabel`. `/balance` folds into the details rows when non-zero.

**Auth reality (tested 2026-10-14):** these endpoints reject the plan API key (`401` with a Xiaomi account login redirect) and the inference gateway (`token-plan-ams.xiaomimimo.com`) exposes no usage routes. The only working credential is the platform browser session: a `Cookie` header containing `api-platform_serviceToken` and `userId`. Suggested managed credential field: `cookie`. (This is the same flow the CodexBar MiMo provider trains users on.)

## Proposed implementation

- `server/lib/quota/providers/alibaba-token-plan.js` and `xiaomi-token-plan-ams.js`, registered in `providers/index.js`, each with `providerId`, `providerName`, `isConfigured()`, `fetchQuota()` and unit tests in the existing `*.test.js` style (parsing + mocked fetch).
- Two normalizers in `server/lib/quota/credentials/providers.js` alongside `exe-dev` / `cursor` / `zenmux`:
  - `alibaba-token-plan` → `{ consoleToken }`
  - `xiaomi-token-plan-ams` → `{ cookie }`
- The matching credential fields on Settings → Usage. If the UI needs more than declaring the field names, the server-side pieces can land first and read a config/env fallback.

Both fetchers are already written and battle-tested against live accounts; happy to submit the PR (branch prepared) and adapt to maintainer preferences on the credential wording or window labels.

## Notes

- The session cookie does expire; the panel surfaces "session expired" and the user pastes a fresh header. Vendors offer no key-based usage API as of today — if either adds one, the module keeps its shape and only swaps the auth header.
- OpenCode itself needs no change: both plan API keys are already in its auth store, which is where the quota modules already look.
