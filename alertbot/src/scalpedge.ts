import "./env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { WARMUP, fetchDeepHistory, precomputeSignals, mean } from "./alphacore.js";
import { structureLevels } from "./plan.js";
import type { Candle } from "./types.js";

/**
 * `npm run scalpedge` — does the user's STRUCTURAL SCALP/TRAIL exit beat the current fixed target?
 *
 * Idea: enter, take profit at the NEAREST structural level (scalp), and — for the trailing variant — as price
 * crosses each further level, ratchet the protective exit up to the PRIOR level ("trail the TP to the last
 * level, keep going till the final resistance"). We measure three exits from the same entry, on signals that
 * actually HAVE structure beyond entry (causal 250-bar swing pivots), fixed-R, 48-bar horizon, per-source
 * busy-gate. Compared vs the current single fixed target. If scalp/trail lifts the earner (bear-short) cohort
 * it's worth wiring as an opt-in exit; if not, keep fixed and the structural levels stay display-only.
 */

const SYMBOLS = config.watchlist;
const TARGET = 6000;
const HORIZON = 48;
const WIN = 250; // causal window for swing-pivot structure

function rFixed(long: boolean, entry: number, stop: number, target: number, future: Candle[]): { r: number; exitBar: number } {
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

/** Scalp: exit at the nearest structural level `lvl` as the target (stop unchanged). */
function rScalp(long: boolean, entry: number, stop: number, lvl: number, future: Candle[]): number {
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return 0;
  const rt = Math.abs(lvl - entry) / risk;
  for (const c of future) {
    if (long ? c.low <= stop : c.high >= stop) return -1;
    if (long ? c.high >= lvl : c.low <= lvl) return rt;
  }
  const last = future[future.length - 1];
  return last ? (long ? last.close - entry : entry - last.close) / risk : 0;
}

/** Structural trail: as price crosses each level, ratchet the exit floor up to the PRIOR level (entry after L1). */
function rTrail(long: boolean, entry: number, stop: number, levels: number[], future: Candle[]): number {
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return 0;
  const sign = long ? 1 : -1;
  let floor = stop;
  let crossed = 0;
  for (const c of future) {
    if (long ? c.low <= floor : c.high >= floor) return (sign * (floor - entry)) / risk;
    while (crossed < levels.length && (long ? c.high >= levels[crossed]! : c.low <= levels[crossed]!)) {
      crossed++;
      floor = crossed >= 2 ? levels[crossed - 2]! : entry; // after L1→breakeven, after L2→L1, after L3→L2…
    }
  }
  const last = future[future.length - 1];
  return last ? (sign * (last.close - entry)) / risk : 0;
}

type Bucket = { fixed: number[]; scalp: number[]; trail: number[] };
const mk = (): Bucket => ({ fixed: [], scalp: [], trail: [] });

async function main() {
  console.log(`STRUCTURAL SCALP / TRAIL EXIT — does it beat the fixed target? ${SYMBOLS.join("/")} @ ${config.interval}\n`);
  const all = mk(), bearShort = mk(), bsEarly = mk(), bsLate = mk();
  const L = config.strategies.marketRegimeLookback;
  const BAND = config.strategies.marketRegimeBandPct / 100;
  let withStructure = 0, total = 0;

  for (const sym of SYMBOLS) {
    const candles = await fetchDeepHistory(sym, config.interval, TARGET);
    if (!candles || candles.length < L + WARMUP + 400) { console.error(`not enough history for ${sym}`); continue; }
    const n = candles.length;
    const splitAt = Math.floor(n * 0.6); // chronological OOS split: early 60% train-era vs late 40% recent
    const idx: number[] = [1];
    for (let i = 1; i < n; i++) idx[i] = idx[i - 1]! * (candles[i]!.close / candles[i - 1]!.close);
    const bear = (i: number) => i >= L && idx[i]! / idx[i - L]! - 1 < -BAND;
    const sigAt = precomputeSignals(sym, candles);
    const busy: Record<string, number> = {};

    for (let i = WARMUP; i < n - 1; i++) {
      const sigs = sigAt[i]!;
      if (!sigs.length) continue;
      const future = candles.slice(i + 1, i + 1 + HORIZON);
      const win = candles.slice(Math.max(0, i - WIN), i + 1);
      const inBearShort = bear(i);
      for (const sg of sigs) {
        if ((busy[sg.source] ?? -1) >= i) continue;
        const fx = rFixed(sg.long, sg.entry, sg.stop, sg.target, future);
        busy[sg.source] = i + fx.exitBar;
        total++;
        const levels = structureLevels(sg.long ? "LONG" : "SHORT", sg.entry, win, 5);
        if (!levels.length) continue; // only compare where structure exists to scalp to
        withStructure++;
        const rs = { fixed: fx.r, scalp: rScalp(sg.long, sg.entry, sg.stop, levels[0]!, future), trail: rTrail(sg.long, sg.entry, sg.stop, levels, future) };
        for (const k of ["fixed", "scalp", "trail"] as const) {
          all[k].push(rs[k]);
          if (inBearShort && !sg.long) { bearShort[k].push(rs[k]); (i < splitAt ? bsEarly : bsLate)[k].push(rs[k]); }
        }
      }
    }
  }

  const exp = (a: number[]) => (a.length ? mean(a) : NaN);
  const win = (a: number[]) => (a.length ? (a.filter((r) => r > 0).length / a.length) * 100 : NaN);
  const cell = (a: number[]) => (Number.isFinite(exp(a)) ? `${exp(a) >= 0 ? "+" : ""}${exp(a).toFixed(3)}R/${win(a).toFixed(0)}%/n${a.length}` : "—");
  console.log(`  (${withStructure}/${total} signals had structure beyond entry to scalp to)\n`);
  console.log(`  exit            ${"ALL (w/ structure)".padStart(22)}   ${"BEAR shorts (earner)".padStart(22)}`);
  for (const k of ["fixed", "scalp", "trail"] as const) {
    console.log(`  ${k.padEnd(6)}  ${cell(all[k]).padStart(22)}   ${cell(bearShort[k]).padStart(22)}`);
  }

  const dScalp = exp(bearShort.scalp) - exp(bearShort.fixed);
  const dTrail = exp(bearShort.trail) - exp(bearShort.fixed);
  const f = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(3)}R` : "n/a");
  console.log(`\nVERDICT (bear-short earner, vs fixed): scalp-to-nearest ${f(dScalp)} · structural-trail ${f(dTrail)}`);
  const helps = (Number.isFinite(dScalp) && dScalp > 0.03) || (Number.isFinite(dTrail) && dTrail > 0.03);
  console.log(
    helps
      ? "→ a structural scalp/trail exit BEATS the fixed target on the earner cohort — worth wiring as an opt-in exit mode (validate OOS first)."
      : "→ neither scalp nor structural-trail beats the fixed target on the earner cohort — keep fixed; the structural levels stay display-only scalp guides.",
  );
  console.log(`(In-sample, gross R, ${HORIZON}-bar horizon, causal ${WIN}-bar structure; scalp = exit at nearest level, trail = ratchet exit to the prior level as each is crossed.)`);

  const lateEdge = exp(bsLate.trail) - exp(bsLate.fixed);
  const earlyEdge = exp(bsEarly.trail) - exp(bsEarly.fixed);
  console.log(`\nOOS (bear-short, chronological split): trail-vs-fixed  EARLY 60% ${f(earlyEdge)}  ·  LATE 40% ${f(lateEdge)}`);
  console.log(`  early: fixed ${cell(bsEarly.fixed)} trail ${cell(bsEarly.trail)}  |  late: fixed ${cell(bsLate.fixed)} trail ${cell(bsLate.trail)}`);
  console.log(
    Number.isFinite(lateEdge) && lateEdge > 0.02
      ? "  → trail edge HOLDS in the recent (out-of-sample) half — worth wiring as an opt-in exit."
      : "  → trail edge does NOT hold in the recent half — the in-sample lift is period-dependent; keep fixed (structural levels stay display-only).",
  );

  const out = {
    generatedAt: new Date().toISOString(), symbols: SYMBOLS, horizon: HORIZON,
    all: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, { exp: exp(v), win: win(v), n: v.length }])),
    bearShort: Object.fromEntries(Object.entries(bearShort).map(([k, v]) => [k, { exp: exp(v), win: win(v), n: v.length }])),
    verdict: { dScalp, dTrail, helps }, withStructure, total,
  };
  await mkdir(dirname("data/scalpedge.json"), { recursive: true });
  await writeFile("data/scalpedge.json", JSON.stringify(out, null, 2), "utf8");
  console.log("\nSaved → data/scalpedge.json");
}

main().catch((e) => {
  console.error(`scalpedge failed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
