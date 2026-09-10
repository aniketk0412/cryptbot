import "./env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { fetchDeepHistory, mean } from "./alphacore.js";
import { rsiSeries, emaSeries } from "./indicators.js";
import type { Candle } from "./types.js";

/**
 * `npm run bouncedge` — is there a NEW long edge the bot lacks: counter-trend OVERSOLD BOUNCES in downtrends?
 *
 * The systematic analysis of the existing machinery is done (return is edge-capped). This tests a genuinely
 * NEW hypothesis at the bot's one gap — the missing long side. Setup: in a DOWNTREND (close < EMA50 and
 * EMA20 < EMA50), when RSI is OVERSOLD and the candle turns up (close > prior close), go LONG a mean-reversion
 * bounce. Exit measured two ways: revert to EMA20 (the mean) and a fixed 2R. Stop = 1×ATR below entry. This is
 * a documented phenomenon (capitulation bounces) and directly targets where the bot has no edge today. Sweeps
 * the RSI threshold so a lucky-tight cut doesn't masquerade as an edge. No lookahead; per-symbol busy-gate;
 * in-sample, gross R, 48-bar horizon — speculative, directional. A +EV result here = a candidate to prototype.
 */

const SYMBOLS = config.watchlist;
const TARGET = 6000;
const HORIZON = 48;
const START = 60;
const STOP_ATR = 1.0;
const MIN_RR = 1.0;
const RSI_LOOSE = 40; // collect candidates below this; bucket tighter below

function atrAt(c: Candle[], i: number, period = 14): number {
  let s = 0, cnt = 0;
  for (let j = Math.max(1, i - period + 1); j <= i; j++) {
    const cur = c[j]!, p = c[j - 1]!;
    s += Math.max(cur.high - cur.low, Math.abs(cur.high - p.close), Math.abs(cur.low - p.close));
    cnt++;
  }
  return cnt ? s / cnt : 0;
}

/** Long-only first-touch R. */
function longR(entry: number, stop: number, target: number, future: Candle[]): { r: number; exitBar: number } {
  const risk = entry - stop;
  if (risk <= 0) return { r: 0, exitBar: future.length };
  const rt = (target - entry) / risk;
  for (let j = 0; j < future.length; j++) {
    const c = future[j]!;
    if (c.low <= stop) return { r: -1, exitBar: j + 1 };
    if (c.high >= target) return { r: rt, exitBar: j + 1 };
  }
  const last = future[future.length - 1];
  return { r: last ? (last.close - entry) / risk : 0, exitBar: future.length };
}

interface Cand { rsi: number; rRevert: number | null; r2R: number }
const exp = (a: number[]) => (a.length ? mean(a) : NaN);
const win = (a: number[]) => (a.length ? (a.filter((r) => r > 0).length / a.length) * 100 : NaN);
const cell = (a: number[]) => (a.length ? `${exp(a) >= 0 ? "+" : ""}${exp(a).toFixed(3)}R / ${win(a).toFixed(0)}% / n${a.length}` : "—");

async function main() {
  console.log(`BOUNCE EDGE — counter-trend oversold longs in downtrends (a NEW-edge test). ${SYMBOLS.join("/")} @ ${config.interval}\n`);
  const cands: Cand[] = [];
  for (const s of SYMBOLS) {
    const c = await fetchDeepHistory(s, config.interval, TARGET);
    if (!c || c.length < START + HORIZON + 100) { console.error(`not enough history for ${s} (${c?.length ?? 0})`); process.exit(1); }
    const closes = c.map((x) => x.close);
    const rsi = rsiSeries(closes, 14);
    const ema20 = emaSeries(closes, 20);
    const ema50 = emaSeries(closes, 50);
    let busy = -1;
    for (let i = START; i < c.length - 1; i++) {
      if (i <= busy) continue;
      const r = rsi[i]!;
      if (!Number.isFinite(r) || r >= RSI_LOOSE) continue;
      const downtrend = closes[i]! < ema50[i]! && ema20[i]! < ema50[i]!;
      const turnUp = closes[i]! > closes[i - 1]!;
      if (!downtrend || !turnUp) continue;
      const entry = closes[i]!;
      const atr = atrAt(c, i);
      if (atr <= 0) continue;
      const stop = entry - STOP_ATR * atr;
      const risk = entry - stop;
      const future = c.slice(i + 1, i + 1 + HORIZON);
      const revTarget = ema20[i]!;
      const rRevert = revTarget > entry && (revTarget - entry) / risk >= MIN_RR ? longR(entry, stop, revTarget, future).r : null;
      const fx = longR(entry, stop, entry + 2 * risk, future);
      busy = i + fx.exitBar;
      cands.push({ rsi: r, rRevert, r2R: fx.r });
    }
  }

  console.log(`Collected ${cands.length} downtrend oversold-bounce setups (RSI<${RSI_LOOSE}, close>prior).\n`);
  console.log(`  RSI cut   revert-to-EMA20 target          fixed-2R target`);
  for (const thr of [25, 30, 35, 40]) {
    const sub = cands.filter((x) => x.rsi < thr);
    const rev = sub.map((x) => x.rRevert).filter((v): v is number => v !== null);
    const r2 = sub.map((x) => x.r2R);
    console.log(`  < ${thr}     ${cell(rev).padEnd(30)}   ${cell(r2)}`);
  }

  const all2R = cands.map((x) => x.r2R);
  const allRev = cands.map((x) => x.rRevert).filter((v): v is number => v !== null);
  const best2R = Math.max(...[25, 30, 35, 40].map((thr) => exp(cands.filter((x) => x.rsi < thr).map((x) => x.r2R))).filter(Number.isFinite));
  const bestRev = Math.max(...[25, 30, 35, 40].map((thr) => { const r = cands.filter((x) => x.rsi < thr).map((x) => x.rRevert).filter((v): v is number => v !== null); return r.length >= 30 ? exp(r) : -Infinity; }));
  const edge = Math.max(Number.isFinite(best2R) ? best2R : -Infinity, Number.isFinite(bestRev) ? bestRev : -Infinity);
  console.log(
    `\nVERDICT: ${edge >= 0.1
      ? `PROMISING — counter-trend bounce longs measure +EV (best ${edge.toFixed(3)}R/trade) across usable RSI cuts. A candidate NEW long edge for downtrends — prototype as a strategy and validate OUT-OF-SAMPLE before trusting (the existing longs looked fine in-sample too).`
      : edge >= 0.02
        ? `MARGINAL — a small positive tilt (best ${edge.toFixed(3)}R) but not clearly worth the complexity/curve-fit risk; the long side stays hard. Re-test on other symbols/timeframes.`
        : `NO EDGE — oversold bounces in downtrends are NOT profitable here (best ${edge.toFixed(3)}R); catching falling knives loses, as expected. The missing long side isn't recovered this way — the bot's short-only character is confirmed structural.`}`,
  );
  console.log(`(All setups: 2R ${cell(all2R)}, revert ${cell(allRev)}. In-sample, gross R, ${HORIZON}-bar horizon — speculative, validate OOS.)`);

  const out = { generatedAt: new Date().toISOString(), symbols: SYMBOLS, interval: config.interval, horizon: HORIZON, stopAtr: STOP_ATR,
    setups: cands.length, byThreshold: [25, 30, 35, 40].map((thr) => { const sub = cands.filter((x) => x.rsi < thr); const rev = sub.map((x) => x.rRevert).filter((v): v is number => v !== null); return { thr, revertExp: exp(rev), revertN: rev.length, r2rExp: exp(sub.map((x) => x.r2R)), r2rN: sub.length }; }) };
  await mkdir(dirname("data/bouncedge.json"), { recursive: true });
  await writeFile("data/bouncedge.json", JSON.stringify(out, null, 2), "utf8");
  console.log("\nSaved → data/bouncedge.json");
}

main().catch((e) => {
  console.error(`bouncedge failed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
