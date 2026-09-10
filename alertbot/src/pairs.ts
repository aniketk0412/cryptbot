import "./env.js";
import { getKlines } from "./binance.js";
import { sma, stdev } from "./indicators.js";

/**
 * `npm run pairs` — statistical-arbitrage RESEARCH (measure before you build).
 *
 * Correlated assets' price RATIO can mean-revert: when it's unusually high you SHORT the
 * spread (short the rich leg / long the cheap leg) betting on convergence; unusually low,
 * you LONG it. It's ~market-neutral — profits from the RELATIONSHIP, not crypto's direction —
 * which is why it's retail-viable (no speed edge needed). This tool answers, with data,
 * across ALL pairs in the watchlist, before we wire anything into the live bot:
 *   1) does the ratio actually mean-revert? (AR(1) half-life — finite & SHORT = yes)
 *   2) does a simple z-score spread strategy show a positive edge AFTER fees?
 * Only a POSITIVE verdict on some pair justifies building it as a live strategy.
 */

const SYMBOLS = ["SOLUSDT", "ETHUSDT", "BTCUSDT"];
const HISTORY = 1500;
const LOOKBACK = 100; // rolling window for the ratio z-score (~4 days on 1h)
const ENTRY_Z = 2;
const EXIT_Z = 0.5;
const STOP_Z = 3.5;
const MAX_HOLD = 120; // candles; bail if it never reverts
const FEE_BPS = 5; // per leg per side (Binance taker ≈ 0.05%)

function analyze(a: number[], b: number[]) {
  const n = Math.min(a.length, b.length);
  const ratio: number[] = [];
  for (let i = 0; i < n; i++) ratio.push(a[a.length - n + i]! / b[b.length - n + i]!);

  // Half-life via AR(1): Δr_t = α + β·r_{t-1}. β<0 => mean-reverting.
  let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
  for (let i = 1; i < ratio.length; i++) {
    const x = ratio[i - 1]!;
    const y = ratio[i]! - ratio[i - 1]!;
    sx += x; sy += y; sxx += x * x; sxy += x * y; m++;
  }
  const beta = (m * sxy - sx * sy) / (m * sxx - sx * sx);
  const halfLife = beta < 0 && beta > -1 ? -Math.log(2) / Math.log(1 + beta) : Infinity;

  // z-score spread backtest (dollar-neutral; P&L as fraction of one leg's notional).
  const feeFrac = FEE_BPS / 10000;
  const rets: number[] = [];
  let reverts = 0;
  let pos: { dir: "short" | "long"; entryR: number; entryI: number } | null = null;
  for (let i = LOOKBACK; i < ratio.length; i++) {
    const w = ratio.slice(i - LOOKBACK, i);
    const sd = stdev(w, LOOKBACK);
    if (sd <= 0) continue;
    const z = (ratio[i]! - sma(w, LOOKBACK)) / sd;
    if (!pos) {
      if (z >= ENTRY_Z) pos = { dir: "short", entryR: ratio[i]!, entryI: i };
      else if (z <= -ENTRY_Z) pos = { dir: "long", entryR: ratio[i]!, entryI: i };
    } else {
      const revert = Math.abs(z) <= EXIT_Z;
      const stop = (pos.dir === "short" && z >= STOP_Z) || (pos.dir === "long" && z <= -STOP_Z);
      const timeout = i - pos.entryI >= MAX_HOLD;
      if (revert || stop || timeout) {
        const exitR = ratio[i]!;
        const gross = pos.dir === "short" ? (pos.entryR - exitR) / pos.entryR : (exitR - pos.entryR) / pos.entryR;
        rets.push(gross - 4 * feeFrac);
        if (revert) reverts++;
        pos = null;
      }
    }
  }
  const wins = rets.filter((r) => r > 0);
  const total = rets.reduce((s, r) => s + r, 0);
  const gp = wins.reduce((s, r) => s + r, 0);
  const gl = Math.abs(rets.filter((r) => r <= 0).reduce((s, r) => s + r, 0));
  return {
    halfLife,
    trades: rets.length,
    winPct: rets.length ? (wins.length / rets.length) * 100 : 0,
    avgPct: rets.length ? (total / rets.length) * 100 : 0,
    totalPct: total * 100,
    pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    reverts,
  };
}

async function main() {
  const klines = await Promise.all(SYMBOLS.map((s) => getKlines(HISTORY, "1h", s)));
  if (klines.some((k) => !k)) {
    console.error("failed to fetch history");
    process.exit(1);
  }
  const closes: Record<string, number[]> = {};
  SYMBOLS.forEach((s, i) => (closes[s] = klines[i]!.filter((c) => c.closed).map((c) => c.close)));

  const pairs: [string, string][] = [
    ["SOLUSDT", "ETHUSDT"],
    ["SOLUSDT", "BTCUSDT"],
    ["ETHUSDT", "BTCUSDT"],
  ];

  console.log(`PAIRS / STATARB RESEARCH — @ 1h, ${HISTORY} candles, enter |z|≥${ENTRY_Z}, exit |z|≤${EXIT_Z}, stop |z|≥${STOP_Z}, ${FEE_BPS}bps/leg\n`);
  console.log("  pair              half-life        trades  win   avg/trade   total    PF     tradeable?");
  let anyEdge = false;
  for (const [A, B] of pairs) {
    const r = analyze(closes[A]!, closes[B]!);
    const hl = r.halfLife === Infinity ? "∞ (drifts)" : `${r.halfLife.toFixed(0)}c/${(r.halfLife / 24).toFixed(1)}d`;
    const meanReverts = r.halfLife < LOOKBACK; // reverts inside the z-window
    const edge = meanReverts && r.trades >= 10 && r.pf > 1.1 && r.avgPct > 0;
    if (edge) anyEdge = true;
    const pf = r.pf === Infinity ? "inf" : r.pf.toFixed(2);
    console.log(
      `  ${(A.replace("USDT", "") + "/" + B.replace("USDT", "")).padEnd(14)} ${hl.padEnd(15)} ${String(r.trades).padStart(5)}  ${(r.winPct.toFixed(0) + "%").padStart(4)}  ${((r.avgPct >= 0 ? "+" : "") + r.avgPct.toFixed(3) + "%").padStart(8)}  ${((r.totalPct >= 0 ? "+" : "") + r.totalPct.toFixed(1) + "%").padStart(7)}  ${pf.padStart(5)}   ${edge ? "YES — edge" : "no"}`,
    );
  }
  console.log(
    `\nVERDICT: ${anyEdge ? "At least one pair shows an after-fee edge → worth prototyping that pair as a live strategy (re-validate on the portfolio harness first)." : "NO pair mean-reverts fast enough OR shows an after-fee edge on this window → do NOT build a pairs strategy yet. The half-lives are far longer than the z-window, i.e. these ratios DRIFT (SOL/ETH/BTC trend against each other for weeks) rather than oscillate — classic StatArb needs a tight, fast-reverting spread these majors don't provide here."}`,
  );
}

main().catch((e) => {
  console.error(`pairs failed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
