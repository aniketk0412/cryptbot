import "./env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { WARMUP, alignByTime, fetchDeepHistory, precomputeSignals, mean } from "./alphacore.js";
import type { Candle } from "./types.js";

/**
 * `npm run timeframe` — is 1h even the right timeframe? Compare the edge on 15m / 1h / 4h.
 *
 * All the analysis so far is 1h. The short-trend edge might be stronger on 4h (less noise) or weaker on 15m.
 * This runs the SAME signal engine on each timeframe and reports per-trade expectancy (avg R, the
 * timeframe-comparable measure) overall and on the earning cohort (bear-regime shorts). Higher bear-short
 * expectancy ⇒ a better timeframe to run the bot on. Same bar-based params + 168-bar basket regime on each
 * (so "168 bars" is 7d on 1h, 28d on 4h — a fair engine, different calendar). No lookahead, gross R,
 * fixed 48-bar horizon. In-sample; spans differ by timeframe (noted) — directional.
 */

const SYMBOLS = config.watchlist;
const TARGET = 5000;
const HORIZON = 48;
const L = config.strategies.marketRegimeLookback;
const BAND = config.strategies.marketRegimeBandPct / 100;
const TIMEFRAMES = ["15m", "1h", "4h"];

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

interface TFResult { tf: string; days: number; allR: number[]; bearShortR: number[] }

async function runTF(tf: string): Promise<TFResult | null> {
  const raw: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) {
    const c = await fetchDeepHistory(s, tf, TARGET);
    if (!c || c.length < L + WARMUP + 200) return null;
    raw[s] = c;
  }
  const bySym = alignByTime(raw, SYMBOLS);
  const n = bySym[SYMBOLS[0]!]!.length;
  const idx: number[] = [1];
  for (let i = 1; i < n; i++) { let r = 0; for (const s of SYMBOLS) { const c = bySym[s]!; r += c[i]!.close / c[i - 1]!.close - 1; } idx[i] = idx[i - 1]! * (1 + r / SYMBOLS.length); }
  const bear = (i: number) => i >= L && idx[i]! / idx[i - L]! - 1 < -BAND;
  const days = (bySym[SYMBOLS[0]!]![n - 1]!.closeTime - bySym[SYMBOLS[0]!]![0]!.openTime) / 8.64e7;

  const allR: number[] = [], bearShortR: number[] = [];
  for (const sym of SYMBOLS) {
    const c = bySym[sym]!;
    const sigAt = precomputeSignals(sym, c);
    const busy: Record<string, number> = {};
    for (let i = WARMUP; i < n - 1; i++) {
      const sigs = sigAt[i]!;
      if (!sigs.length) continue;
      const future = c.slice(i + 1, i + 1 + HORIZON);
      const inBear = bear(i);
      for (const sg of sigs) {
        if ((busy[sg.source] ?? -1) >= i) continue;
        const { r, exitBar } = fixedR(sg.long, sg.entry, sg.stop, sg.target, future);
        busy[sg.source] = i + exitBar;
        allR.push(r);
        if (inBear && !sg.long) bearShortR.push(r);
      }
    }
  }
  return { tf, days, allR, bearShortR };
}

async function main() {
  console.log(`TIMEFRAME EDGE — is 1h optimal? ${SYMBOLS.join("/")}, per-trade expectancy (avg R)\n`);
  const results: TFResult[] = [];
  for (const tf of TIMEFRAMES) {
    const r = await runTF(tf);
    if (r) results.push(r); else console.log(`  ${tf}: not enough history — skipped`);
  }
  if (!results.length) { console.error("no timeframe produced data"); process.exit(1); }

  console.log(`  tf     span        all signals                    bear-shorts (earner)`);
  for (const r of results) {
    console.log(`  ${r.tf.padEnd(5)}  ${(r.days.toFixed(0) + "d").padStart(6)}   ${cell(r.allR).padEnd(30)}   ${cell(r.bearShortR)}`);
  }

  const best = [...results].filter((r) => r.bearShortR.length >= 30).sort((a, b) => exp(b.bearShortR) - exp(a.bearShortR))[0];
  const oneH = results.find((r) => r.tf === "1h");
  console.log(
    `\nVERDICT: ${!best
      ? `no timeframe has a usable bear-short sample — inconclusive.`
      : best.tf === "1h"
        ? `1h is already the best timeframe for the bear-short edge (${exp(best.bearShortR).toFixed(3)}R) — no reason to switch.`
        : oneH && exp(best.bearShortR) - exp(oneH.bearShortR) >= 0.05
          ? `${best.tf} shows a STRONGER bear-short edge (${exp(best.bearShortR).toFixed(3)}R vs 1h ${exp(oneH.bearShortR).toFixed(3)}R) → worth testing the bot on ${best.tf} (validate OOS; fewer 4h bars = slower to accumulate a live record).`
          : `${best.tf} edges 1h slightly (${exp(best.bearShortR).toFixed(3)}R vs ${oneH ? exp(oneH.bearShortR).toFixed(3) : "—"}R) but not decisively — 1h is fine; the timeframe isn't the bottleneck.`}`,
  );
  console.log(`(In-sample, gross R, ${HORIZON}-bar horizon. Spans differ by timeframe — expectancy/trade is the fair comparison, not totals.)`);

  const out = { generatedAt: new Date().toISOString(), symbols: SYMBOLS, horizon: HORIZON,
    timeframes: results.map((r) => ({ tf: r.tf, days: r.days, allExp: exp(r.allR), allN: r.allR.length, bearShortExp: exp(r.bearShortR), bearShortWin: win(r.bearShortR), bearShortN: r.bearShortR.length })) };
  await mkdir(dirname("data/timeframe.json"), { recursive: true });
  await writeFile("data/timeframe.json", JSON.stringify(out, null, 2), "utf8");
  console.log(`\nSaved → data/timeframe.json  (spans: ${results.map((r) => `${r.tf} ${r.days.toFixed(0)}d`).join(" · ")})`);
}

main().catch((e) => {
  console.error(`timeframe failed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
