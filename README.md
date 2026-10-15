# Token Plans — OpenChamber extension

> **One line:** Usage bars for the Alibaba Cloud Model Studio Token Plan (monthly quota + quota add-ons) and the Xiaomi MiMo Token Plan (credits, period, balance), in an OpenChamber rail panel — the two plans OpenChamber's built-in Usage page can't show.

A rail panel that shows how much of your subscription plans you've used:

- **Alibaba Cloud Model Studio (Token Plan)** — via the Bailian CLI (`bl usage token-plan --output json`)
- **Xiaomi MiMo Token Plan** — via `https://platform.xiaomimimo.com/api/v1/{balance,tokenPlan/detail,tokenPlan/usage}`

OpenChamber's built-in **Settings → Usage** page only covers its fixed provider list
(Claude, Codex, Google, …), and a generic quota API for custom providers was declined
(openchamber/openchamber#2327). This extension adds the two token plans as a panel
instead. It survives OpenChamber updates.

## Layout

```
package.json      manifest (panel + local service)
panel/            the rail panel (sandboxed page, bundled IIFE)
service/main.js   local process: runs `bl`, calls the MiMo API, serves /usage
```

The panel cannot reach the network itself, so a local service (declared under
`contributes.service`) does the fetching and answers `GET /usage`, `GET/PUT /config`
on the host-managed loopback. It runs `bl` and reads its login from `~/.bailian/`.

## Install

1. Build (already built in this folder):

   ```sh
   npm install
   npm run build
   ```

2. OpenChamber → **Settings → Extensions** → paste this folder's absolute path → **Add**.
3. Approve the dialog (it requests the `service` capability and `bl` execution).
4. Click the **Token Plans** icon on the rail.

## One-time setup

### Alibaba: console login for `bl`

The usage query goes through the Model Studio **console** API, so `bl` needs a console
access token. The problem on a remote server: `bl auth login --console` waits on
`127.0.0.1:<port>` of **this machine**, and the console page POSTs the token to
`http://<notice>` from **your browser** — browsers only allow that to their own
loopback, so the login silently dies when the browser runs elsewhere. Pick one:

**Option A — SSH tunnel (no secrets in chat).** On this server:

```sh
node tools/bailian-console-login.mjs            # prints an authorize URL, port 46640
```

On your laptop:

```sh
ssh -N -L 46640:127.0.0.1:46640 <user>@<this-server>
```

Then open the printed URL in the laptop browser and click **Authorize**. The token
lands in `~/.bailian/config.json` and the script exits. (You can equally run
`bl auth login --console` here and forward whatever port its link shows.)

**Option B — log in on your own computer.** On the laptop:

```sh
npm install -g bailian-cli
bl auth login --console --console-site international
```

Then copy the `access_token` value from `~/.bailian/config.json`
(`%USERPROFILE%\.bailian\config.json` on Windows) and paste it into the panel's
**Settings → Bailian console token**. The extension stores it where the server's
`bl` expects it.

(Subscription keys like `sk-sp-…` cannot use `--console` for model calls, but the
usage command needs exactly this console session.) If the panel says *"No console
access token found"*, that's this step. The **Bailian console site** and **region**
settings override the gateway if the default doesn't match your subscription.

### Xiaomi MiMo: session cookie

Your plan shows at <https://platform.xiaomimimo.com/console/plan-manage> (it is a
subscription; the data still comes from `/api/v1/tokenPlan/detail` and
`/api/v1/tokenPlan/usage`, the same calls that page makes):

1. Log in at <https://platform.xiaomimimo.com/console/plan-manage>.
2. DevTools (F12) → **Network** tab → click any request to `platform.xiaomimimo.com`
   (reload the page if the list is empty) → **Headers** → **Request Headers** →
   find the `cookie:` line → right-click → **Copy value**.
   The value must include `api-platform_serviceToken` and `userId`.
3. Paste it into **Settings → Xiaomi MiMo cookie** in the panel and save.

Don't pick individual cookies from the Application tab — the API needs the whole
header. The cookie is stored by the service in
`~/.config/openchamber-token-plan-usage/config.json` (mode 0600). MiMo sessions
expire; the panel tells you when to re-copy one.

## Service API

| Route | Answer |
| --- | --- |
| `GET /health` | `{ ok: true }` (readiness probe) |
| `GET /usage` | `{ fetchedAt, alibaba, xiaomi }` — each `{ ok: true, data }` or `{ ok: false, error, hint, needsConsoleLogin?, needsCookie? }` |
| `GET /config` | config minus secrets (`mimoCookieSet`, `blConsoleLogin`, `blProfile` report what is stored) |
| `PUT /config` | `{ mimoCookie?, mimoApiUrl?, blConsoleSite?, blConsoleRegion?, blConsoleToken? }` — `blConsoleToken` is written into `~/.bailian/config.json` as the console `access_token` |

`tools/bailian-console-login.mjs` is a standalone receiver for the SSH-tunnel
login flow (fixed port, writes the token into `~/.bailian/config.json`).

## Notes

- The Alibaba response is passed through with a light normalization (`data.windows`
  with `used`/`limit`/`percent` when recognizable); unrecognized shapes fall back to
  the raw payload in the panel.
- `mimoApiUrl` in the config overrides the MiMo API base (defaults to
  `https://platform.xiaomimimo.com/api/v1`).
