import "./env.js";
import { getKlines } from "./binance.js";
import { config } from "./config.js";

/**
 * `npm run regime` — what the bear-only filter sees RIGHT NOW, and how far the market is from letting
 * the bot trade.
 *
 * The filter (config.strategies.marketRegimeFilter) only opens new paper entries when the equal-weight
 * SOL/BTC/ETH basket's trailing `marketRegimeLookback`-bar return is below −`marketRegimeBandPct`% (a causal
 * downtrend). This prints that exact number, the threshold, and the gap — so "the bot isn't trading" is a
 * measurable state, not a mystery. Same math the live filter runs each cycle (no lookahead).
 */

const L = config.strategies.marketRegimeLookback;
const BAND = config.strategies.marketRegimeBandPct / 100;
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;

async function main() {
  const symbols = config.watchlist;
  const closes: number[][] = [];
  for (const s of symbols) {
    const c = await getKlines(L + 5, config.interval, s);
    if (!c) { console.error(`failed to fetch ${s}`); process.exit(1); }
    const cl = c.filter((x) => x.closed).map((x) => x.close);
    if (cl.length < L + 1) { console.error(`not enough candles for ${s}`); process.exit(1); }
    closes.push(cl.slice(-(L + 1)));
  }

  // Equal-weight basket index, rebalanced each bar — identical to marketregime.ts / the live filter.
  let idx = 1;
  for (let k = 1; k <= L; k++) {
    let r = 0;
    for (let i = 0; i < symbols.length; i++) r += closes[i]![k]! / closes[i]![k - 1]! - 1;
    idx *= 1 + r / symbols.length;
  }
  const trail = idx - 1;
  const regime = trail > BAND ? "BULL" : trail < -BAND ? "BEAR" : "FLAT";

  console.log(`MARKET REGIME — what the bear-only filter sees. ${symbols.join("/")} @ ${config.interval}\n`);
  console.log(`  Basket trailing ${L}-bar (~${(L / 24).toFixed(0)}d) return : ${pct(trail)}`);
  console.log(`  Bear threshold (bot trades below this)      : ${pct(-BAND)}`);
  console.log(`  Current regime                              : ${regime}`);
  console.log(`\n  Per-symbol trailing ~${(L / 24).toFixed(0)}d:`);
  for (let i = 0; i < symbols.length; i++) {
    console.log(`    ${symbols[i]!.padEnd(9)} ${pct(closes[i]![L]! / closes[i]![0]! - 1)}`);
  }

  if (regime === "BEAR") {
    console.log(`\n✅ BEAR — the filter is ALLOWING entries. The bot will short setups as they fire.`);
  } else {
    console.log(`\n⏸  ${regime} — the filter is PAUSING entries (correct: no measured edge here).`);
    console.log(`   The basket must fall a further ${pct(trail + BAND)} (to below ${pct(-BAND)}) before the bot trades.`);
  }
  console.log(`\n(Causal trailing return, no lookahead — exactly what the live filter computes each cycle.)`);
}

main().catch((e) => {
  console.error(`regime failed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
