// Timing budgets are reported, never asserted, so slow CI machines don't flake.
import type { TestContext } from "node:test";

export function reportTiming(t: TestContext, label: string, ms: number, budgetMs: number): void {
  const verdict = ms <= budgetMs ? "within" : "OVER";
  t.diagnostic(`timing: ${label} ${ms.toFixed(1)} ms (${verdict} the ${budgetMs} ms budget)`);
}

/** Median of several runs, which is steadier than a single sample. */
export function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
