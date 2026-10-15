// Minimal DOM/host fakes for lifecycle tests. They exercise the real panel and
// status modules (imported after mock.module) against repeated onReady firing
// and overlapping service responses.

export class FakeNode {
  tagName: string;
  children: FakeNode[] = [];
  className = "";
  textContent = "";
  style: Record<string, string> = {};
  replaceCalls = 0;
  classList = {
    add: (...cls: string[]) => {
      this.className = [this.className, ...cls].filter(Boolean).join(" ");
    },
  };

  constructor(tag: string) {
    this.tagName = tag;
  }

  append(...nodes: unknown[]) {
    for (const node of nodes) this.children.push(node as FakeNode);
  }

  prepend(...nodes: unknown[]) {
    this.children.unshift(...(nodes as FakeNode[]));
  }

  replaceChildren(...nodes: unknown[]) {
    this.replaceCalls += 1;
    this.children = [...(nodes as FakeNode[])];
  }

  getBoundingClientRect() {
    return { height: 100 };
  }

  setAttribute() {}
  addEventListener() {}
  removeEventListener() {}
}

export type ServiceResponse = { status: number; body: string };

export class FakeHost {
  ready: Array<(ctx: unknown) => void> = [];
  pendingRequests: Array<{ resolve: (value: ServiceResponse) => void; reject: (error: unknown) => void }> = [];
  heights: number[] = [];
  respond?: (request: { method: string; path: string }) => ServiceResponse;

  onReady(callback: (ctx: unknown) => void) {
    this.ready.push(callback);
  }

  serviceRequest(request: { method: string; path: string }) {
    if (this.respond) return Promise.resolve(this.respond(request));
    return new Promise<ServiceResponse>((resolve, reject) => {
      this.pendingRequests.push({ resolve, reject });
    });
  }

  setHeight(height: number) {
    this.heights.push(height);
    return Promise.resolve();
  }

  serviceStatus() {
    return Promise.resolve({ status: "ready" });
  }
}

export function installDom(): FakeNode {
  const root = new FakeNode("div");
  const document = {
    createElement: (tag: string) => new FakeNode(tag),
    querySelector: () => root,
    documentElement: new FakeNode("html"),
    head: new FakeNode("head"),
    body: new FakeNode("body"),
  };
  (globalThis as Record<string, unknown>).document = document;
  return root;
}

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

export const usagePayload = (label: string, error?: string) =>
  JSON.stringify({
    alibaba: error
      ? { ok: false, error }
      : { ok: true, data: { windows: [{ label, used: 1, limit: 1, percent: 100 }] } },
    xiaomi: {
      ok: true,
      data: {
        planCode: "lite",
        planName: "Lite",
        periodEnd: "2026-11-14 23:59:59",
        expired: false,
        windows: [
          {
            label: "Monthly credits",
            used: 2_100_219_044,
            limit: 4_100_000_000,
            percent: 51.2,
            resetsAt: "2026-11-14T23:59:59.000Z",
          },
        ],
        balance: "0.00",
        currency: "USD",
        cashBalance: "0.00",
        giftBalance: "0.00",
      },
    },
    fetchedAt: "2026-10-15T00:00:00Z",
  });
