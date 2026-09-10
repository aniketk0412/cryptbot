import { config } from "./config.js";

const INTERVALS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d"];

/**
 * Validate the config at startup — fail fast on anything that would make the bot
 * misbehave, warn on questionable-but-runnable settings. Called once from main().
 */
export function validateConfig(): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const c = config;

  if (!c.watchlist || c.watchlist.length === 0) errors.push("watchlist is empty — nothing to scan");
  for (const s of c.watchlist ?? []) {
    if (!/^[A-Z0-9]+USDT$/.test(s)) warnings.push(`'${s}' doesn't look like a USDⓈ-M perp (expected …USDT)`);
  }
  if (!INTERVALS.includes(c.interval)) errors.push(`interval '${c.interval}' isn't a Binance kline interval`);
  if (!INTERVALS.includes(c.structure.htfInterval)) warnings.push(`structure.htfInterval '${c.structure.htfInterval}' isn't a standard interval`);

  const hungriest = Math.max(c.strategies.emaSlow, c.strategies.tsmomLookback, c.lookback) + 5;
  if (c.candleHistory < hungriest) warnings.push(`candleHistory ${c.candleHistory} < ${hungriest} — the hungriest consumer may starve (silent nulls)`);
  if (c.lookback < 5) warnings.push(`lookback ${c.lookback} is very small`);

  const pct = (v: number, name: string) => { if (v <= 0 || v > 100) errors.push(`${name} = ${v} must be in (0, 100]`); };
  pct(c.plan.riskPct, "plan.riskPct");
  pct(c.paper.riskPct, "paper.riskPct");
  if (c.paper.feeBps < 0) errors.push(`paper.feeBps ${c.paper.feeBps} < 0`);
  if (c.paper.slippageBps < 0) errors.push(`paper.slippageBps ${c.paper.slippageBps} < 0`);
  if (c.paper.startBalanceUsd <= 0) errors.push("paper.startBalanceUsd must be > 0");
  if (c.paper.maxOpenPerSymbol < 1) warnings.push("paper.maxOpenPerSymbol < 1 — no paper positions will ever open");
  if (c.paper.maxSameDirection < 0) errors.push("paper.maxSameDirection < 0 (use 0 to disable the correlation cap)");
  if (c.paper.exit.breakevenAtR < 0) errors.push("paper.exit.breakevenAtR < 0");
  if (c.dashboard.port < 1 || c.dashboard.port > 65535) errors.push(`dashboard.port ${c.dashboard.port} out of range (1–65535)`);
  if (c.pollIntervalSec < 1) errors.push("pollIntervalSec must be >= 1");
  if (c.maxRangeWidthPct <= c.minRangeWidthPct) errors.push(`maxRangeWidthPct (${c.maxRangeWidthPct}) must be > minRangeWidthPct (${c.minRangeWidthPct})`);

  if (c.levelMode === "manual" && !(c.manualResistance > c.manualSupport && c.manualSupport > 0)) {
    errors.push(`manual levels invalid: RESISTANCE (${c.manualResistance}) must be > SUPPORT (${c.manualSupport}) > 0`);
  }

  return { errors, warnings };
}
