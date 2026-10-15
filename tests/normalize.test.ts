import { describe, expect, it } from "bun:test";
import {
  buildXiaomiWindows,
  parseUtcReset,
  pickExtraItems,
  toCreditsItem,
} from "../service/normalize.ts";

const periodEnd = "2026-11-14 23:59:59";

const monthItem = { name: "month_total_token", used: 2_100_219_044, limit: 4_100_000_000, percent: 0.5122 };
const planItem = { name: "plan_total_token", used: 2_100_219_044, limit: 4_100_000_000, percent: 0.51 };
const compensationItem = { name: "compensation_total_token", used: 100, limit: 1_000, percent: 0.1 };

describe("xiaomi usage normalization", () => {
  it("converts fractional percentages to 0..100", () => {
    const item = toCreditsItem(monthItem);
    expect(item.percent).toBeCloseTo(51.22, 2);
    expect(item.name).toBe("Monthly credits");
  });

  it("prefers used/limit over the reported fraction", () => {
    const item = toCreditsItem({ name: "month_total_token", used: 1, limit: 4, percent: 0.99 });
    expect(item.percent).toBeCloseTo(25, 5);
  });

  it("drops the duplicated plan-total bucket but keeps distinct extras", () => {
    const used = 2_100_219_044;
    const limit = 4_100_000_000;
    const extras = pickExtraItems([planItem, compensationItem], used, limit);
    expect(extras.map((item) => item.name)).toEqual(["Compensation credits"]);
  });

  it("keeps the plan-total bucket when it is genuinely distinct", () => {
    const extras = pickExtraItems([{ name: "plan_total_token", used: 5, limit: 9, percent: 0.5 }], 5, 10);
    expect(extras).toHaveLength(1);
    expect(extras[0].percent).toBeCloseTo(55.55, 1);
  });

  it("parses the documented UTC period end and rejects garbage", () => {
    expect(parseUtcReset(periodEnd)).toBe("2026-11-14T23:59:59.000Z");
    expect(parseUtcReset("not a date")).toBeNull();
    expect(parseUtcReset(undefined)).toBeNull();
    expect(parseUtcReset("")).toBeNull();
  });

  it("builds the monthly window plus extras when a limit exists", () => {
    const windows = buildXiaomiWindows({
      used: 2_100_219_044,
      limit: 4_100_000_000,
      percent: 51.22,
      items: [toCreditsItem(monthItem), toCreditsItem({ name: "other", used: 1, limit: 2, percent: 0.5 })],
      extras: [toCreditsItem(compensationItem)],
      periodEnd,
    });
    expect(windows.map((window) => window.label)).toEqual(["Monthly credits", "other", "Compensation credits"]);
    expect(windows[0].resetsAt).toBe("2026-11-14T23:59:59.000Z");
    expect(windows[1].resetsAt).toBeNull();
    expect(windows[2].resetsAt).toBeNull();
    expect(windows[0].percent).toBeCloseTo(51.22, 2);
  });

  it("renders items alone when the monthly limit is zero or missing", () => {
    const windows = buildXiaomiWindows({
      used: 10,
      limit: 0,
      percent: 0,
      items: [toCreditsItem({ name: "month_total_token", used: 10, limit: 0, percent: 0.25 })],
      extras: [],
      periodEnd,
    });
    expect(windows).toHaveLength(1);
    expect(windows[0].label).toBe("Monthly credits"); // no synthetic window, no duplicate
    expect(windows[0].percent).toBeCloseTo(25, 5); // fraction fallback when limit is unusable
  });
});
