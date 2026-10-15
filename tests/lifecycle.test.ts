import { describe, expect, it, mock } from "bun:test";
import { FakeHost, FakeNode, tick, usagePayload } from "./fakes.ts";

// One file, one mock set: bun runs test files in one process and mock.module
// leaks across files. Each module under test gets its own host and root,
// assigned in import order below.
const statusHost = new FakeHost();
const panelHost = new FakeHost();
const statusRoot = new FakeNode("div");
const panelRoot = new FakeNode("div");
let connectCalls = 0;
let queryCalls = 0;

mock.module("@openchamber/sdk", () => ({
  connectHost: () => (connectCalls++ === 0 ? statusHost : panelHost),
  HostRequestError: class HostRequestError extends Error {
    code = "TEST";
  },
}));
const handle = () => ({ update: () => {}, dispose: () => {} });
mock.module("@openchamber/sdk/ui", () => ({
  applyHostReady: () => {},
  mountBadge: handle,
  mountBanner: handle,
  mountButton: handle,
  mountProgress: handle,
  mountSelect: handle,
  mountTextField: handle,
}));

(globalThis as Record<string, unknown>).document = {
  createElement: (tag: string) => new FakeNode(tag),
  querySelector: () => (queryCalls++ === 0 ? statusRoot : panelRoot),
  documentElement: new FakeNode("html"),
  head: new FakeNode("head"),
  body: new FakeNode("body"),
};

// Import order below defines the host/root assignment above.
await import("../status/main.ts");
await import("../panel/main.ts");

const fireReady = (host: FakeHost, surface: string) => {
  for (const callback of [...host.ready]) callback({ theme: { mode: "light" }, surface });
};

describe("status section lifecycle", () => {
  it("renders one group per provider when overlapping refreshes complete in any order", async () => {
    fireReady(statusHost, "status");
    fireReady(statusHost, "status"); // onReady repeats (theme/session snapshots)
    await tick();
    expect(statusHost.pendingRequests.length).toBe(2);

    // Complete the newer request first, then the stale one.
    statusHost.pendingRequests[1].resolve({ status: 200, body: usagePayload("newer") });
    await tick();
    statusHost.pendingRequests[0].resolve({ status: 200, body: usagePayload("stale") });
    await tick();

    expect(statusRoot.children.length).toBe(2); // one group per provider, never doubled
    const labels = statusRoot.children.map((group) => group.children[1]?.children[0]?.children[0]?.textContent);
    expect(labels).toContain("newer"); // the stale response did not overwrite it

    // Xiaomi renders a real bar row, not a bare header.
    const xiaomiRow = statusRoot.children[1].children[1];
    expect(xiaomiRow.children[0].children[0].textContent).toBe("Monthly credits");
    expect(xiaomiRow.children[0].children[1].textContent).toBe("51%");
    expect(xiaomiRow.children[1].children[0].style.width).toBe("51.2%");
  });

  it("leaves a single error note on failure", async () => {
    fireReady(statusHost, "status");
    await tick();
    statusHost.pendingRequests[statusHost.pendingRequests.length - 1].resolve({ status: 500, body: "" });
    await tick();
    expect(statusRoot.children.length).toBe(1);
  });
});

describe("panel lifecycle", () => {
  it("initializes once: repeated onReady keeps one build, one timer, and settings drafts", async () => {
    const realSetInterval = globalThis.setInterval;
    let intervalCalls = 0;
    (globalThis as { setInterval: unknown }).setInterval = () => {
      intervalCalls += 1;
      return 0;
    };
    panelHost.respond = (request) =>
      request.path === "/config"
        ? {
            status: 200,
            body: JSON.stringify({
              mimoCookieSet: false,
              mimoApiUrl: "https://platform.xiaomimimo.com/api/v1",
              blConsoleSite: "",
              blConsoleRegion: "",
              blConsoleLogin: true,
              blProfile: "token-plan",
            }),
          }
        : { status: 200, body: usagePayload("fresh") };

    fireReady(panelHost, "panel");
    await tick();
    await tick();
    expect(panelRoot.replaceCalls).toBe(1); // the DOM is built exactly once
    expect(intervalCalls).toBe(1); // exactly one refresh timer

    fireReady(panelHost, "panel"); // a later theme/session snapshot
    await tick();
    await tick();
    expect(panelRoot.replaceCalls).toBe(1); // no rebuild, so settings drafts survive
    expect(intervalCalls).toBe(1);

    // The Xiaomi card renders the service windows with numeric and reset
    // formatting intact.
    const xiaomiBody = panelRoot.children[2].children[1];
    expect(xiaomiBody.children[0].children[0].textContent).toBe("Lite"); // plan chip
    const row = xiaomiBody.children[1];
    expect(row.children[0].textContent).toBe("Monthly credits");
    expect(row.children[1].textContent).toBe("2.1B / 4.1B · 51%");
    expect(row.children[2].children[0].style.width).toBe("51.2%");
    expect(String(row.children[3]?.textContent ?? "")).toContain("resets");

    (globalThis as { setInterval: unknown }).setInterval = realSetInterval;
  });
});
