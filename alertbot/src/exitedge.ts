import "./env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { WARMUP, alignByTime, fetchDeepHistory, precomputeSignals, mean } from "./alphacore.js";
import type { Candle } from "./types.js";

/**
 * `npm run exitedge` — can better TRADE MANAGEMENT lift return where the regime filter can't?
 *
 * `npm run regimeoos` showed the bear-only filter only cuts drawdown, not return; the bot's P&L comes
 * entirely from the winning SHORTS in downtrends. So the remaining lever for RETURN is the exit. This
 * replays every signal from the SAME entry under several exit strategies and compares expectancy (avg R),
 * overall and for the earning cohort (shorts taken in a bear regime):
 *   • fixed        — first-touch stop / fixed target (today's engine)
 *   • trail-Nx     — ATR trailing stop, no fixed target (let winners run)
 *   • partial-1R   — take half at +1R, move stop to breakeven, rest to target
 *   • time-N       — fixed stop/target but force-close at the candle after N bars
 * No lookahead (each exit judged only on candles > entry; stop-first within a bar). Per-source busy-gate
 * (on the fixed exit) so a persistent setup isn't counted many times. In-sample, gross R (pre-fee),
 * fixed 48-bar horizon — directional evidence for whether an exit change is worth prototyping.
 */

const SYMBOLS = config.watchlist;
const TARGET = 6000;
const HORIZON = 48;
const L = config.strategies.marketRegimeLookback;
const BAND = config.strategies.marketRegimeBandPct / 100;

function atrAt(c: Candle[], i: number, period = 14): number {
  let sum = 0, cnt = 0;
  for (let j = Math.max(1, i - period + 1); j <= i; j++) {
    const cur = c[j]!, prev = c[j - 1]!;
    sum += Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    cnt++;
  }
  return cnt ? sum / cnt : 0;
}

/** Fixed stop / target, first touch. Returns R and the bar it exited (for the busy-gate). */
function exitFixed(long: boolean, entry: number, stop: number, target: number, future: Candle[]): { r: number; exitBar: number } {
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return { r: 0, exitBar: future.length };
  const rt = Math.abs(target - entry) / risk;
  for (let j = 0; j < future.length; j++) {
    const c = future[j]!;
    if (long ? c.low <= stop : c.high >= stop) return { r: -1, exitBar: j + 1 };
    if (long ? c.high >= target : c.low <= target) return { r: rt, exitBar: j + 1 };
  }
  const last = future[future.length - 1];
  return { r: last ? (long ? last.close - entry : entry - last.close) / risk : 0, exitBar: future.length };
}

/** ATR trailing stop, no fixed target — ratchet the stop toward price by mult×ATR; exit when hit. */
function exitTrail(long: boolean, entry: number, stop: number, atr: number, future: Candle[], mult: number): number {
  const risk = Math.abs(entry - stop);
  if (risk <= 0 || atr <= 0) return 0;
  let trail = stop, peak = entry;
  for (const c of future) {
    if (long ? c.low <= trail : c.high >= trail) return (long ? trail - entry : entry - trail) / risk;
    if (long) { peak = Math.max(peak, c.high); trail = Math.max(trail, peak - mult * atr); }
    else { peak = Math.min(peak, c.low); trail = Math.min(trail, peak + mult * atr); }
  }
  const last = future[future.length - 1];
  return last ? (long ? last.close - entry : entry - last.close) / risk : 0;
}

/** Take half at +tpR, move stop to breakeven, run the rest to target. */
function exitPartial(long: boolean, entry: number, stop: number, target: number, future: Candle[], tpR: number): number {
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return 0;
  const rt = Math.abs(target - entry) / risk;
  const tp = long ? entry + tpR * risk : entry - tpR * risk;
  let took = false, curStop = stop;
  for (const c of future) {
    if (long ? c.low <= curStop : c.high >= curStop) return took ? 0.5 * tpR : -1; // breakeven on 2nd half after partial
    if (long ? c.high >= target : c.low <= target) return took ? 0.5 * tpR + 0.5 * rt : rt;
    if (!took && (long ? c.high >= tp : c.low <= tp)) { took = true; curStop = entry; }
  }
  const last = future[future.length - 1];
  const markR = last ? (long ? last.close - entry : entry - last.close) / risk : 0;
  return took ? 0.5 * tpR + 0.5 * markR : markR;
}

/** Fixed stop/target but force-close at the candle after N bars. */
function exitTime(long: boolean, entry: number, stop: number, target: number, future: Candle[], N: number): number {
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return 0;
  const rt = Math.abs(target - entry) / risk;
  for (let j = 0; j < future.length; j++) {
    const c = future[j]!;
    if (long ? c.low <= stop : c.high >= stop) return -1;
    if (long ? c.high >= target : c.low <= target) return rt;
    if (j >= N - 1) return (long ? c.close - entry : entry - c.close) / risk;
  }
  const last = future[future.length - 1];
  return last ? (long ? last.close - entry : entry - last.close) / risk : 0;
}

/** Max favorable excursion (in R) before the FIXED trade exits — measures "how far in profit did it get". */
function mfeR(long: boolean, entry: number, stop: number, future: Candle[], exitBar: number): number {
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return 0;
  let peak = 0;
  const n = Math.min(exitBar, future.length);
  for (let j = 0; j < n; j++) {
    const c = future[j]!;
    const fav = long ? c.high - entry : entry - c.low;
    if (fav / risk > peak) peak = fav / risk;
  }
  return peak;
}

const STRATS = ["fixed", "trail-2x", "trail-3x", "partial-1R", "partial-1.5R", "partial-2R", "time-24"] as const;
type Strat = (typeof STRATS)[number];

async function main() {
  console.log(`EXIT MANAGEMENT — can a better exit lift return? ${SYMBOLS.join("/")} @ ${config.interval}\n`);
  const raw: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) {
    const c = await fetchDeepHistory(s, config.interval, TARGET);
    if (!c || c.length < L + WARMUP + 400) { console.error(`not enough history for ${s} (${c?.length ?? 0})`); process.exit(1); }
    raw[s] = c;
  }
  const bySym = alignByTime(raw, SYMBOLS);
  const n = bySym[SYMBOLS[0]!]!.length;
  const idx: number[] = [1];
  for (let i = 1; i < n; i++) { let r = 0; for (const s of SYMBOLS) { const c = bySym[s]!; r += c[i]!.close / c[i - 1]!.close - 1; } idx[i] = idx[i - 1]! * (1 + r / SYMBOLS.length); }
  const bear = (i: number) => i >= L && idx[i]! / idx[i - L]! - 1 < -BAND;

  const mk = () => Object.fromEntries(STRATS.map((s) => [s, [] as number[]])) as Record<Strat, number[]>;
  const all = mk(), bearShort = mk(), longs = mk(), shorts = mk();
  let gReached = 0, gGaveBack = 0; // trades that ran to +1R in profit, and how many round-tripped to <=0 under fixed

  for (const sym of SYMBOLS) {
    const closed = bySym[sym]!;
    const sigAt = precomputeSignals(sym, closed);
    const busy: Record<string, number> = {};
    for (let i = WARMUP; i < n - 1; i++) {
      const sigs = sigAt[i]!;
      if (!sigs.length) continue;
      const future = closed.slice(i + 1, i + 1 + HORIZON);
      const atr = atrAt(closed, i);
      const inBearShort = bear(i);
      for (const sg of sigs) {
        if ((busy[sg.source] ?? -1) >= i) continue;
        const fx = exitFixed(sg.long, sg.entry, sg.stop, sg.target, future);
        busy[sg.source] = i + fx.exitBar;
        const rs: Record<Strat, number> = {
          fixed: fx.r,
          "trail-2x": exitTrail(sg.long, sg.entry, sg.stop, atr, future, 2),
          "trail-3x": exitTrail(sg.long, sg.entry, sg.stop, atr, future, 3),
          "partial-1R": exitPartial(sg.long, sg.entry, sg.stop, sg.target, future, 1),
          "partial-1.5R": exitPartial(sg.long, sg.entry, sg.stop, sg.target, future, 1.5),
          "partial-2R": exitPartial(sg.long, sg.entry, sg.stop, sg.target, future, 2),
          "time-24": exitTime(sg.long, sg.entry, sg.stop, sg.target, future, 24),
        };
        for (const st of STRATS) {
          all[st].push(rs[st]);
          (sg.long ? longs : shorts)[st].push(rs[st]);
          if (inBearShort && !sg.long) bearShort[st].push(rs[st]);
        }
        if (mfeR(sg.long, sg.entry, sg.stop, future, fx.exitBar) >= 1) { gReached++; if (fx.r <= 0) gGaveBack++; }
      }
    }
  }

  const exp = (a: number[]) => (a.length ? mean(a) : NaN);
  const win = (a: number[]) => (a.length ? (a.filter((r) => r > 0).length / a.length) * 100 : NaN);
  const cell = (a: number[]) => `${Number.isFinite(exp(a)) ? (exp(a) >= 0 ? "+" : "") + exp(a).toFixed(3) + "R" : "—"}/${win(a).toFixed(0)}%`;

  console.log(`  exit            ${"ALL".padStart(13)} ${"LONG".padStart(13)} ${"SHORT".padStart(13)} ${"BEAR-short".padStart(13)}`);
  for (const st of STRATS) {
    console.log(`  ${st.padEnd(13)} ${cell(all[st]).padStart(13)} ${cell(longs[st]).padStart(13)} ${cell(shorts[st]).padStart(13)} ${cell(bearShort[st]).padStart(13)}`);
  }
  console.log(`  (n: all ${all.fixed.length} · long ${longs.fixed.length} · short ${shorts.fixed.length} · bear-short ${bearShort.fixed.length}; each cell = avg R / win%)`);
  console.log(
    `\nGIVEBACK (today's fixed exit): ${gReached} trades ran to +1R in profit, and ${gGaveBack} of them ` +
      `(${(100 * gGaveBack / Math.max(1, gReached)).toFixed(0)}%) round-tripped to ≤0 R. Partial-TP banks +0.5R on each of those instead of giving it all back.`,
  );

  // Best exit on the earning cohort (bear shorts), vs fixed baseline.
  const baseAll = exp(all.fixed), baseBear = exp(bearShort.fixed);
  let bestBear: Strat = "fixed";
  for (const st of STRATS) if (bearShort[st].length >= 20 && exp(bearShort[st]) > exp(bearShort[bestBear])) bestBear = st;
  const lift = exp(bearShort[bestBear]) - baseBear;
  console.log(
    `\nVERDICT: on the bear-short earner cohort, best exit = "${bestBear}" (${(exp(bearShort[bestBear]) >= 0 ? "+" : "") + exp(bearShort[bestBear]).toFixed(3)}R) ` +
      `vs fixed ${(baseBear >= 0 ? "+" : "") + baseBear.toFixed(3)}R → ${bestBear === "fixed" || lift <= 0.02
        ? "no exit change meaningfully beats the current fixed target — the exit is not the lever; keep fixed."
        : `+${lift.toFixed(3)}R/trade lift → worth prototyping "${bestBear}" for the short book (validate out-of-sample first).`}`,
  );
  console.log(`(Overall all-signal fixed baseline ${(baseAll >= 0 ? "+" : "") + baseAll.toFixed(3)}R. In-sample, gross R, ${HORIZON}-bar horizon — directional only.)`);

  const out = { generatedAt: new Date().toISOString(), symbols: SYMBOLS, interval: config.interval, horizon: HORIZON,
    strategies: STRATS.map((st) => ({ strat: st, allExp: exp(all[st]), allWin: win(all[st]), allN: all[st].length,
      longExp: exp(longs[st]), longWin: win(longs[st]), shortExp: exp(shorts[st]), shortWin: win(shorts[st]),
      bearShortExp: exp(bearShort[st]), bearShortN: bearShort[st].length })),
    giveback: { reached1R: gReached, gaveBack: gGaveBack }, bestBearExit: bestBear };
  await mkdir(dirname("data/exitedge.json"), { recursive: true });
  await writeFile("data/exitedge.json", JSON.stringify(out, null, 2), "utf8");
  console.log("\nSaved → data/exitedge.json");
}

main().catch((e) => {
  console.error(`exitedge failed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
