#!/usr/bin/env node
// One-shot Bailian console-login receiver for remote servers.
//
// `bl auth login --console` binds 127.0.0.1 on the machine it runs on, but the
// console page POSTs the token to http://<notice> from your *browser*. On a
// remote server the browser is on your laptop, so the redirect never lands
// unless the laptop forwards that port here. This script pins the port and
// writes the token straight into ~/.bailian/config.json, so you only need:
//
//   1. On the laptop:  ssh -N -L 46640:127.0.0.1 46640 <user>@<server>
//   2. Open the URL this script prints and click Authorize.
//
// Usage: node tools/bailian-console-login.mjs [--port 46640] [--site international|domestic]
import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const port = Number(flag("port", "46640"));
const site = flag("site", "international");
const state = randomBytes(16).toString("hex");
const notice = `127.0.0.1:${port}?state=${state}`;
const loginBase =
  site === "domestic"
    ? "https://bailian.console.aliyun.com/console-login"
    : "https://modelstudio.console.alibabacloud.com/console-login";

const configDir = process.env.BAILIAN_CONFIG_DIR ?? path.join(os.homedir(), ".bailian");
const configFile = path.join(configDir, "config.json");

function store(payload) {
  const cfg = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};
  const active = cfg.active_config ?? "default";
  cfg.active_config = active;
  cfg[active] = { ...(cfg[active] ?? {}) };
  for (const key of ["access_token", "api_key", "base_url", "console_site", "console_region", "workspace_id"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) cfg[active][key] = value.trim();
    if (typeof value === "number" && key === "workspace_id") cfg[active][key] = value;
    // `bl` also reads top-level keys (flat legacy layout) but never the
    // `default` entry for console tokens — mirror each value up.
    if (typeof value === "string" && value.trim()) cfg[key] = value.trim();
    if (typeof value === "number" && key === "workspace_id") cfg[key] = value;
  }
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configFile, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  return active;
}

const server = http.createServer((req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    let payload = null;
    try {
      payload = JSON.parse(body);
    } catch {
      // fall through
    }
    const query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
    const token = payload?.access_token ?? query.get("access_token") ?? query.get("accessToken");
    if (!token) {
      res.writeHead(400, { ...cors, "Content-Type": "text/html" });
      res.end("<h3>No access token in the request.</h3><p>Close this tab and run the script again.</p>");
      return;
    }
    const profile = store({ ...payload, access_token: token });
    res.writeHead(200, { ...cors, "Content-Type": "text/html" });
    res.end(
      `<h3>Console login captured ✔</h3><p>Stored in <code>${configFile}</code> (profile <code>${profile}</code>). You can close this tab and return to OpenChamber.</p>`,
    );
    console.log(`\n✓ Console access token stored in ${configFile} (profile ${profile}).`);
    server.close();
    setTimeout(() => process.exit(0), 250);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Bailian console login receiver on 127.0.0.1:${port} (${site} site)\n`);
  console.log("1. On your laptop, open a tunnel to this server:");
  console.log(`     ssh -N -L ${port}:127.0.0.1:${port} <user>@<this-server>\n`);
  console.log("2. Then open this URL in the laptop browser and click Authorize:\n");
  console.log(`     ${loginBase}?notice=${notice}\n`);
  console.log("Waiting for the console callback (Ctrl+C to abort)...");
});
