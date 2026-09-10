import "./env.js";
import { fetchDeepHistory } from "./alphacore.js";
import type { Candle } from "./types.js";

/**
 * `npx tsx src/trendedge.ts` — TURTLE / DONCHIAN trend-follower test. `assetchar` showed the ONLY positive
 * net-of-fee signal is breakout continuation at multi-day holds on crypto majors. This tests it HONESTLY as a
 * real strategy: enter on an N-bar Donchian breakout, initial stop = k×ATR, and — crucially — LET WINNERS RUN
 * (exit on the opposite N/2-bar Donchian break, the turtle exit), because a fixed target would cap exactly the
 * trend profit we're trying to measure. Net of taker fees, per symbol, LONG vs SHORT, with a 70/30 OOS split.
 *
 * Why this matters: the bot's existing long side (oversold-BOUNCE, i.e. mean-reversion longs) was measured to
 * LOSE. Momentum/breakout longs are a DIFFERENT hypothesis and were never tested. If breakout-longs pay OOS,
 * that's a genuinely new lever; if not, the short-only character is confirmed structural. Measure, don't guess.
 */

const SYMBOLS = ["BTCUSDT", "SOLUSDT", "ETHUSDT", "XAUTUSDT"];
const FEE = 0.0005; // 5bps/side taker
const ENTRY_N = 20;   // Donchian entry channel (bars)
const EXIT_N = 10;    // Donchian exit channel (turtle: enter 20, exit 10)
const ATR_LB = 20;    // ATR lookback for the stop
const ATR_K = 2;      // initial stop distance in ATRs

interface Trade { dir: "LONG" | "SHORT"; r: number; openMs: number; symbol: string }

function atrSeries(c: Candle[], lb: number): number[] {
  const out = new Array<number>(c.length).fill(NaN);
  const trs = new Array<number>(c.length).fill(NaN);
  for (let i = 1; i < c.length; i++) { const h = c[i]!.high, l = c[i]!.low, pc = c[i - 1]!.close; trs[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)); }
  let a = NaN;
  for (let i = lb; i < c.length; i++) { if (i === lb) { let s = 0; for (let k = 1; k <= lb; k++) s += trs[k]!; a = s / lb; } else a = (a * (lb - 1) + trs[i]!) / lb; out[i] = a; }
  return out;
}

/** Run the turtle system over one symbol's candles → list of closed trades (net R). */
function runTurtle(sym: string, c: Candle[]): Trade[] {
  const atr = atrSeries(c, ATR_LB);
  const trades: Trade[] = [];
  let pos: { dir: "LONG" | "SHORT"; entry: number; stop: number; risk: number; openMs: number } | null = null;
  const WARM = Math.max(ENTRY_N, ATR_LB) + 1;
  for (let i = WARM; i < c.length; i++) {
    const cur = c[i]!;
    if (pos) {
      // exits first: intrabar stop, then opposite N/2 Donchian break on close
      const exitLo = Math.min(...c.slice(i - EXIT_N, i).map((k) => k.low));
      const exitHi = Math.max(...c.slice(i - EXIT_N, i).map((k) => k.high));
      let exit: number | null = null;
      if (pos.dir === "LONG") { if (cur.low <= pos.stop) exit = pos.stop; else if (cur.close < exitLo) exit = cur.close; }
      else { if (cur.high >= pos.stop) exit = pos.stop; else if (cur.close > exitHi) exit = cur.close; }
      if (exit !== null) {
        const sign = pos.dir === "LONG" ? 1 : -1;
        const grossR = (sign * (exit - pos.entry)) / pos.risk;
        const feeR = FEE * (pos.entry + exit) / pos.risk;
        trades.push({ dir: pos.dir, r: grossR - feeR, openMs: pos.openMs, symbol: sym });
        pos = null;
      }
    }
    if (!pos && Number.isFinite(atr[i]!) && atr[i]! > 0) {
      // entry: N-bar Donchian breakout on close
      const hi = Math.max(...c.slice(i - ENTRY_N, i).map((k) => k.high));
      const lo = Math.min(...c.slice(i - ENTRY_N, i).map((k) => k.low));
      if (cur.close > hi) pos = { dir: "LONG", entry: cur.close, stop: cur.close - ATR_K * atr[i]!, risk: ATR_K * atr[i]!, openMs: cur.closeTime };
      else if (cur.close < lo) pos = { dir: "SHORT", entry: cur.close, stop: cur.close + ATR_K * atr[i]!, risk: ATR_K * atr[i]!, openMs: cur.closeTime };
    }
  }
  return trades;
}

const exp = (t: Trade[]) => (t.length ? t.reduce((a, x) => a + x.r, 0) / t.length : NaN);
const win = (t: Trade[]) => (t.length ? (100 * t.filter((x) => x.r > 0).length) / t.length : 0);
const tot = (t: Trade[]) => t.reduce((a, x) => a + x.r, 0);
const f3 = (e: number) => (Number.isFinite(e) ? `${e >= 0 ? "+" : ""}${e.toFixed(3)}R` : "  —  ");

function report(label: string, all: Trade[]) {
  const L = all.filter((t) => t.dir === "LONG"), S = all.filter((t) => t.dir === "SHORT");
  console.log(`\n── ${label} ──   n=${all.length}  exp ${f3(exp(all))}  win ${win(all).toFixed(0)}%  totalR ${tot(all).toFixed(1)}`);
  console.log(`   LONG  n=${String(L.length).padStart(4)}  exp ${f3(exp(L))}  win ${win(L).toFixed(0)}%  totalR ${tot(L).toFixed(1)}`);
  console.log(`   SHORT n=${String(S.length).padStart(4)}  exp ${f3(exp(S))}  win ${win(S).toFixed(0)}%  totalR ${tot(S).toFixed(1)}`);
}

async function main(interval: string, target: number) {
  console.log(`\n╔═══════════════════════════════════════════════════════════════════════╗`);
  console.log(`  TURTLE / DONCHIAN trend-follower @ ${interval}  (enter ${ENTRY_N}-bar break, ${ATR_K}×ATR${ATR_LB} stop, exit ${EXIT_N}-bar opposite break, net ${FEE * 1e4}bps/side)`);
  console.log(`╚═══════════════════════════════════════════════════════════════════════╝`);
  const all: Trade[] = [];
  for (const sym of SYMBOLS) {
    const c = await fetchDeepHistory(sym, interval, target);
    if (!c || c.length < 200) { console.log(`  skip ${sym} (${c?.length ?? 0} candles)`); continue; }
    const t = runTurtle(sym, c);
    report(`${sym}  (${c.length}×${interval})`, t);
    all.push(...t);
  }
  report(`ALL SYMBOLS`, all);
  // OOS: 70/30 by time
  const sorted = [...all].sort((a, b) => a.openMs - b.openMs);
  const cut = Math.floor(sorted.length * 0.7);
  const tr = sorted.slice(0, cut), te = sorted.slice(cut);
  console.log(`\n  OOS (70/30 by time):  train ${f3(exp(tr))} (n=${tr.length}, totalR ${tot(tr).toFixed(1)})   test·held-out ${f3(exp(te))} (n=${te.length}, totalR ${tot(te).toFixed(1)})`);
  console.log(`  LONG-only held-out: ${f3(exp(te.filter((t) => t.dir === "LONG")))} (n=${te.filter((t) => t.dir === "LONG").length})   [is the momentum-LONG side real OOS, or in-sample?]`);
}

(async () => {
  await main("1h", 4500);
  await main("4h", 2500);
})().catch((e) => { console.error(`trendedge failed: ${(e as Error).stack ?? e}`); process.exit(1); });
