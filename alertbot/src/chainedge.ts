import "./env.js";
import { config } from "./config.js";
import { WARMUP, fetchDeepHistory, precomputeSignals } from "./alphacore.js";
import { atr, emaLast } from "./indicators.js";
import type { Candle } from "./types.js";

/**
 * `npm run chainedge` — tests the "CONFLUENCE CHAIN" hypothesis: does stacking more agreeing factors on a signal
 * lift its WIN PROBABILITY (and expectancy), and does it get better on higher timeframes? For every signal in the
 * book (signalsAt = strategies + S/R confirmations) we score 5 backtestable factors that AGREE with the trade
 * direction, then bucket outcomes by how many agree (the "chain length"). Honest, no-lookahead, NET of taker fees.
 *
 * The 5 factors (each +1 if it agrees with the trade side):
 *   trend  — close on the right side of EMA50
 *   pd     — LONG in the discount (lower) half of the last-50 range / SHORT in the premium (upper) half
 *   flow   — signal candle's taker delta (2·takerBuy − vol) agrees with direction
 *   mom    — 20-bar return agrees (TSMOM-style)
 *   zone   — entry within 1·ATR of a recent swing low (demand, LONG) / swing high (supply, SHORT)
 */

const SYMBOLS = (process.env.CHAIN_SYMBOLS ?? "SOLUSDT,BTCUSDT,ETHUSDT").split(",").map((s) => s.trim()).filter(Boolean);
const TIMEFRAMES = (process.env.CHAIN_TF ?? "4h,12h,1d").split(",").map((s) => s.trim()).filter(Boolean);
const DAYS = Number(process.env.CHAIN_DAYS ?? 2000);
const HORIZON = 48;
const FEE = Number(process.env.FEE_BPS ?? config.paper.feeBps) / 10000;

function tfHours(tf: string): number {
  if (tf.endsWith("h")) return Number(tf.slice(0, -1)) || 1;
  if (tf.endsWith("d")) return 24 * (Number(tf.slice(0, -1)) || 1);
  return 1;
}

/** Count of the 5 factors that agree with the trade direction, from candles up to the signal bar. */
function chainScore(window: Candle[], long: boolean, entry: number): number {
  const n = window.length;
  const last = window[n - 1]!;
  const closes = window.map((x) => x.close);
  const ema50 = emaLast(closes, 50);
  const seg = window.slice(-50);
  const hi = Math.max(...seg.map((x) => x.high));
  const lo = Math.min(...seg.map((x) => x.low));
  const pos = (entry - lo) / ((hi - lo) || 1);
  const delta = 2 * last.takerBuyVolume - last.volume;
  const past = window[n - 1 - 20];
  const ret = past ? (last.close - past.close) / past.close : 0;
  const a = atr(window);
  const sw = window.slice(-20);
  const swLow = Math.min(...sw.map((x) => x.low));
  const swHigh = Math.max(...sw.map((x) => x.high));
  const zoneOk = Number.isFinite(a) && a > 0 && (long ? Math.abs(entry - swLow) <= a : Math.abs(entry - swHigh) <= a);
  let score = 0;
  if (Number.isFinite(ema50) && (long ? last.close > ema50 : last.close < ema50)) score++;
  if (long ? pos < 0.5 : pos > 0.5) score++;
  if (long ? delta > 0 : delta < 0) score++;
  if (long ? ret > 0 : ret < 0) score++;
  if (zoneOk) score++;
  return score;
}

/** First-touch fixed stop/target → gross R. */
function exitFixed(long: boolean, entry: number, stop: number, target: number, future: Candle[]): number {
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return 0;
  const rt = Math.abs(target - entry) / risk;
  for (const c of future) {
    if (long ? c.low <= stop : c.high >= stop) return -1;
    if (long ? c.high >= target : c.low <= target) return rt;
  }
  const last = future[future.length - 1];
  return last ? (long ? last.close - entry : entry - last.close) / risk : 0;
}

interface T { r: number; score: number }

async function runTf(tf: string): Promise<void> {
  const target = Math.ceil(DAYS * (24 / tfHours(tf))) + WARMUP + 100;
  const trades: T[] = [];
  for (const sym of SYMBOLS) {
    const c = await fetchDeepHistory(sym, tf, target);
    if (!c || c.length < WARMUP + 100) continue;
    const sigAt = precomputeSignals(sym, c);
    const busy: Record<string, number> = {};
    for (let i = WARMUP; i < c.length - 1; i++) {
      for (const sg of sigAt[i]!) {
        if ((busy[sg.source] ?? -1) >= i) continue;
        const risk = Math.abs(sg.entry - sg.stop);
        if (risk <= 0) continue;
        const future = c.slice(i + 1, i + 1 + HORIZON);
        const gross = exitFixed(sg.long, sg.entry, sg.stop, sg.target, future);
        let exitBar = future.length;
        for (let j = 0; j < future.length; j++) { const fc = future[j]!; if (sg.long ? fc.low <= sg.stop || fc.high >= sg.target : fc.high >= sg.stop || fc.low <= sg.target) { exitBar = j + 1; break; } }
        busy[sg.source] = i + exitBar;
        const exit = sg.long ? sg.entry + gross * risk : sg.entry - gross * risk;
        const net = gross - FEE * ((sg.entry + exit) / risk);
        trades.push({ r: net, score: chainScore(c.slice(0, i + 1), sg.long, sg.entry) });
      }
    }
  }
  const span = trades.length;
  console.log(`\n── ${tf}  (${span} signals) ──  win% + net R by CHAIN LENGTH (agreeing factors, 0–5):`);
  console.log(`   ${"chain".padEnd(8)}${"n".padStart(6)}${"win%".padStart(8)}${"netR".padStart(10)}`);
  for (let s = 0; s <= 5; s++) {
    const b = trades.filter((t) => t.score === s);
    if (!b.length) { console.log(`   ${String(s).padEnd(8)}${"0".padStart(6)}${"—".padStart(8)}${"—".padStart(10)}`); continue; }
    const win = (100 * b.filter((t) => t.r > 0).length) / b.length;
    const exp = b.reduce((a, t) => a + t.r, 0) / b.length;
    console.log(`   ${String(s).padEnd(8)}${String(b.length).padStart(6)}${win.toFixed(0).padStart(7)}%${(`${exp >= 0 ? "+" : ""}${exp.toFixed(3)}R`).padStart(10)}`);
  }
  // "high-conviction" = 4+ factors
  const hi = trades.filter((t) => t.score >= 4);
  if (hi.length) {
    const win = (100 * hi.filter((t) => t.r > 0).length) / hi.length;
    const exp = hi.reduce((a, t) => a + t.r, 0) / hi.length;
    console.log(`   → CHAIN ≥4:  n=${hi.length}  win ${win.toFixed(0)}%  net ${exp >= 0 ? "+" : ""}${exp.toFixed(3)}R`);
  }
}

async function main() {
  console.log(`CONFLUENCE-CHAIN EDGE — does stacking factors lift win probability? ${SYMBOLS.join("/")} @ [${TIMEFRAMES.join(", ")}], net ${FEE * 1e4}bps`);
  for (const tf of TIMEFRAMES) await runTf(tf);
  console.log(`\nREAD: if win% and netR rise monotonically with chain length AND ≥4 clears ~55%+ with positive netR, the "chain" is real.`);
  console.log(`If win% is flat across chain lengths, stacking factors is NOT selecting winners (the factors are noise / already priced in).`);
}

main().catch((e) => { console.error(`chainedge failed: ${(e as Error).stack ?? e}`); process.exit(1); });
