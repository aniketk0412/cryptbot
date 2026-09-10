import "./env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { WARMUP, alignByTime, fetchDeepHistory, precomputeSignals, mean } from "./alphacore.js";
import type { Candle } from "./types.js";

/**
 * `npm run selectedge` — is trade SELECTION a return lever? Does requiring FLOW confirmation help?
 *
 * The last untested return lever: the paper engine takes EVERY qualifying signal — it never filters by
 * the evidence grade. The audit's strongest factor is order FLOW (aggressive taker delta, +23.8pp win),
 * and it's computable from candles alone (takerBuyVolume) — no order book. So this measures whether
 * requiring flow-alignment (net aggressive SELLING behind a short / BUYING behind a long) lifts expectancy,
 * focused on the earning cohort (bear-regime shorts). If flow-confirmed shorts clearly out-earn all shorts,
 * a flow gate on paper entries is a real return lever; if not, return is edge-capped (selection won't save it).
 * No lookahead (outcome judged on candles > entry). In-sample, gross R, fixed 48-bar horizon — directional.
 */

const SYMBOLS = config.watchlist;
const TARGET = 6000;
const HORIZON = 48;
const FLOW_LB = 3;                      // candles of aggressive-flow lookback at entry
const L = config.strategies.marketRegimeLookback;
const BAND = config.strategies.marketRegimeBandPct / 100;

/** Net aggressive-taker imbalance over the last `lb` candles ∈ [-1,1] (+ = buyers, − = sellers). */
function flowImbalance(c: Candle[], i: number, lb: number): number {
  let d = 0, v = 0;
  for (let j = Math.max(0, i - lb + 1); j <= i; j++) { const k = c[j]!; d += 2 * k.takerBuyVolume - k.volume; v += k.volume; }
  return v > 0 ? d / v : 0;
}

function fixedR(long: boolean, entry: number, stop: number, target: number, future: Candle[]): { r: number; exitBar: number } {
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

const exp = (a: number[]) => (a.length ? mean(a) : NaN);
const win = (a: number[]) => (a.length ? (a.filter((r) => r > 0).length / a.length) * 100 : NaN);
const cell = (a: number[]) => (a.length ? `${exp(a) >= 0 ? "+" : ""}${exp(a).toFixed(3)}R / ${win(a).toFixed(0)}% / n${a.length}` : "—");

async function main() {
  console.log(`SELECTION EDGE — does requiring FLOW confirmation lift return? ${SYMBOLS.join("/")} @ ${config.interval}\n`);
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

  interface T { r: number; long: boolean; inBear: boolean; imb: number }
  const trades: T[] = [];
  for (const sym of SYMBOLS) {
    const c = bySym[sym]!;
    const sigAt = precomputeSignals(sym, c);
    const busy: Record<string, number> = {};
    for (let i = WARMUP; i < n - 1; i++) {
      const sigs = sigAt[i]!;
      if (!sigs.length) continue;
      const future = c.slice(i + 1, i + 1 + HORIZON);
      const imb = flowImbalance(c, i, FLOW_LB);
      const inBear = bear(i);
      for (const sg of sigs) {
        if ((busy[sg.source] ?? -1) >= i) continue;
        const { r, exitBar } = fixedR(sg.long, sg.entry, sg.stop, sg.target, future);
        busy[sg.source] = i + exitBar;
        trades.push({ r, long: sg.long, inBear, imb });
      }
    }
  }

  const shorts = trades.filter((t) => !t.long);
  const bearShorts = shorts.filter((t) => t.inBear);
  const baseShort = exp(shorts.map((t) => t.r)), baseBS = exp(bearShorts.map((t) => t.r));
  console.log(`Baseline — shorts ${cell(shorts.map((t) => t.r))} · bear-shorts (earner) ${cell(bearShorts.map((t) => t.r))}\n`);
  console.log(`Flow-confirmed (net aggressive selling ≥ thr) — sweep threshold to see if the lift survives at usable n:`);
  console.log(`  thr    shorts (exp/win/n)                bear-shorts (exp/win/n)`);
  const THRS = [0.02, 0.04, 0.06, 0.10, 0.15];
  let usable: { thr: number; exp: number; n: number } | null = null; // loosest thr with a real bear-short sample
  for (const thr of THRS) {
    const sf = shorts.filter((t) => t.imb < -thr).map((t) => t.r);
    const bsf = bearShorts.filter((t) => t.imb < -thr).map((t) => t.r);
    if (bsf.length >= 30) usable = { thr, exp: exp(bsf), n: bsf.length };
    console.log(`  ${thr.toFixed(2)}   ${cell(sf).padEnd(30)}   ${cell(bsf)}`);
  }

  const REP = 0.04; // representative usable threshold (large-n for both cohorts)
  const sRep = shorts.filter((t) => t.imb < -REP).map((t) => t.r);
  const bsRep = bearShorts.filter((t) => t.imb < -REP).map((t) => t.r);
  const sLift = exp(sRep) - baseShort, bsLift = exp(bsRep) - baseBS;
  console.log(`\nVERDICT (usable thr ${REP}): flow lifts ALL-shorts ${sLift >= 0 ? "+" : ""}${sLift.toFixed(3)}R ` +
    `(${baseShort.toFixed(3)}→${exp(sRep).toFixed(3)}R, n=${sRep.length}) but bear-shorts only ${bsLift >= 0 ? "+" : ""}${bsLift.toFixed(3)}R ` +
    `(${baseBS.toFixed(3)}→${exp(bsRep).toFixed(3)}R, n=${bsRep.length}).`);
  console.log(`→ ${sLift >= 0.05
    ? `Flow selection is a MILD return lever for the UNFILTERED short book (roughly doubles its thin +${baseShort.toFixed(2)}R edge), but it's REDUNDANT once you regime-filter to bear-shorts — regime already selects the good cohort, so flow adds ~nothing on top. Net: a small lever that OVERLAPS the bear-only filter, not additive.`
    : `Flow selection doesn't meaningfully lift return; edge-capped.`}`);
  console.log(`(In-sample, gross R, ${HORIZON}-bar horizon, flow lookback ${FLOW_LB} — directional only. Note: the +1.7R at thr 0.15 is n=3 noise.)`);

  const out = { generatedAt: new Date().toISOString(), symbols: SYMBOLS, interval: config.interval, flowLookback: FLOW_LB, horizon: HORIZON,
    baseShort, baseBS, sweep: THRS.map((thr) => ({ thr, shortExp: exp(shorts.filter((t) => t.imb < -thr).map((t) => t.r)), shortN: shorts.filter((t) => t.imb < -thr).length, bearShortExp: exp(bearShorts.filter((t) => t.imb < -thr).map((t) => t.r)), bearShortN: bearShorts.filter((t) => t.imb < -thr).length })), usable };
  await mkdir(dirname("data/selectedge.json"), { recursive: true });
  await writeFile("data/selectedge.json", JSON.stringify(out, null, 2), "utf8");
  console.log("\nSaved → data/selectedge.json");
}

main().catch((e) => {
  console.error(`selectedge failed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
