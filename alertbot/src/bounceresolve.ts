import "./env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { fetchDeepHistory, mean } from "./alphacore.js";
import { rsiSeries, emaSeries } from "./indicators.js";
import type { Candle } from "./types.js";

/**
 * `npm run bounceresolve` — when price bounces in a downtrend (the XRP rising-channel setup), does it more
 * often RESUME DOWN (bear-flag continuation) or REVERSE UP? Prompted by a live XRP 1h chart.
 *
 * Event = an oversold RECOVERY inside a downtrend: RSI crosses up through 45 having been <35 in the last 10
 * bars, while close is still below EMA50 (a corrective bounce, not a fresh trend). From that point it's a
 * race over the next 48 bars: does price break the recent swing low FIRST (CONTINUATION) or reclaim EMA50
 * FIRST (REVERSAL)? Also measures the expectancy of SHORTING the bounce (stop above the bounce high, target
 * = the swing low). Answers the practical question: chase the bounce, or wait to short the breakdown?
 * No lookahead; per-symbol busy-gate; in-sample, gross R — directional evidence.
 */

const SYMBOLS = ["SOLUSDT", "BTCUSDT", "ETHUSDT", "XRPUSDT", "AVAXUSDT", "DOGEUSDT", "DOTUSDT"];
const TARGET = 5000;
const H = 48;      // forward horizon (bars)
const SW = 12;     // swing-low / bounce-high lookback
const START = 60;

function shortR(entry: number, stop: number, target: number, future: Candle[]): number {
  const risk = stop - entry;
  if (risk <= 0) return 0;
  const rt = (entry - target) / risk;
  for (const c of future) {
    if (c.high >= stop) return -1;
    if (c.low <= target) return rt;
  }
  const last = future[future.length - 1];
  return last ? (entry - last.close) / risk : 0;
}

const pct = (n: number, d: number) => (d ? ((n / d) * 100).toFixed(0) + "%" : "—");
const exp = (a: number[]) => (a.length ? mean(a) : NaN);
const win = (a: number[]) => (a.length ? (a.filter((r) => r > 0).length / a.length) * 100 : NaN);

interface Row { sym: string; cont: number; rev: number; undec: number; shortRs: number[] }

async function main() {
  console.log(`BOUNCE RESOLUTION — oversold recovery in a downtrend: continuation vs reversal? ${SYMBOLS.join("/")} @ ${config.interval}\n`);
  const rows: Row[] = [];
  for (const sym of SYMBOLS) {
    const c = await fetchDeepHistory(sym, config.interval, TARGET);
    if (!c || c.length < START + H + 100) { console.log(`  ${sym} — insufficient history, skipped`); continue; }
    const closes = c.map((x) => x.close);
    const rsi = rsiSeries(closes, 14);
    const ema50 = emaSeries(closes, 50);
    let cont = 0, rev = 0, undec = 0;
    const shortRs: number[] = [];
    let busy = -1;
    for (let i = START; i < c.length - 1 - 1; i++) {
      if (i <= busy) continue;
      if (!(Number.isFinite(rsi[i - 1]!) && rsi[i - 1]! < 45 && rsi[i]! >= 45)) continue; // RSI crossing up through 45
      let os = false; for (let j = Math.max(0, i - 10); j <= i; j++) if (rsi[j]! < 35) os = true;
      if (!os) continue;                       // must have been oversold recently
      if (!(closes[i]! < ema50[i]!)) continue; // still a downtrend (corrective bounce)
      let swingLow = Infinity, recHigh = -Infinity;
      for (let j = Math.max(0, i - SW); j <= i; j++) { swingLow = Math.min(swingLow, c[j]!.low); recHigh = Math.max(recHigh, c[j]!.high); }
      // Race: new low below swingLow (continuation) vs reclaim EMA50 (reversal), whichever first.
      let outcome: "cont" | "rev" | "undec" = "undec";
      let resolveBar = i + H;
      for (let j = i + 1; j <= Math.min(c.length - 1, i + H); j++) {
        if (c[j]!.low < swingLow) { outcome = "cont"; resolveBar = j; break; }
        if (closes[j]! > ema50[j]!) { outcome = "rev"; resolveBar = j; break; }
      }
      if (outcome === "cont") cont++; else if (outcome === "rev") rev++; else undec++;
      busy = resolveBar;
      // Short-the-bounce expectancy: stop just above the bounce high, target = the swing low.
      const future = c.slice(i + 1, i + 1 + H);
      const r = shortR(closes[i]!, recHigh * 1.003, swingLow, future);
      if (recHigh * 1.003 - closes[i]! > 0) shortRs.push(r);
    }
    rows.push({ sym, cont, rev, undec, shortRs });
  }

  console.log(`  symbol      events   continuation   reversal   undecided    short-the-bounce (expR/win)`);
  for (const r of rows) {
    const tot = r.cont + r.rev + r.undec;
    console.log(`  ${r.sym.padEnd(9)}  ${String(tot).padStart(5)}    ${pct(r.cont, tot).padStart(8)}      ${pct(r.rev, tot).padStart(6)}    ${pct(r.undec, tot).padStart(6)}     ${r.shortRs.length ? `${exp(r.shortRs) >= 0 ? "+" : ""}${exp(r.shortRs).toFixed(3)}R / ${win(r.shortRs).toFixed(0)}%` : "—"}`);
  }

  const C = rows.reduce((s, r) => s + r.cont, 0), R = rows.reduce((s, r) => s + r.rev, 0), U = rows.reduce((s, r) => s + r.undec, 0);
  const tot = C + R + U;
  const allShort = rows.flatMap((r) => r.shortRs);
  console.log(`\n  ALL: ${tot} events → CONTINUATION ${pct(C, tot)} · reversal ${pct(R, tot)} · undecided ${pct(U, tot)}.  Short-the-bounce ${exp(allShort) >= 0 ? "+" : ""}${exp(allShort).toFixed(3)}R / ${win(allShort).toFixed(0)}% (n${allShort.length}).`);
  const contRate = tot ? C / (C + R) : 0; // continuation share of DECIDED cases
  console.log(
    `\nVERDICT: of the decided cases, the downtrend RESUMES ${(contRate * 100).toFixed(0)}% of the time` +
      ` (${C} continue vs ${R} reverse). ${contRate >= 0.55 && exp(allShort) > 0.02
        ? `→ the XRP-style bounce more often RESUMES DOWN, and shorting it is +EV. Practical read: don't chase the bounce long — wait for the breakdown (loss of the swing low) and short the continuation, which is exactly the bot's edge.`
        : contRate <= 0.45
          ? `→ these bounces more often REVERSE — the recovery is a real bottoming signal more often than not; shorting it is dangerous.`
          : `→ roughly a coin-flip between continuation and reversal — no reliable edge either way at the bounce; wait for the level (swing low or EMA50 reclaim) to resolve before acting.`}`,
  );
  console.log(`(In-sample, gross R, ${H}-bar horizon. "Continuation" = new low below the swing low before reclaiming EMA50. Directional evidence, not a prediction.)`);

  const out = { generatedAt: new Date().toISOString(), symbols: SYMBOLS, interval: config.interval, horizon: H,
    perSymbol: rows.map((r) => ({ sym: r.sym, cont: r.cont, rev: r.rev, undec: r.undec, shortExp: exp(r.shortRs), shortN: r.shortRs.length })),
    total: { cont: C, rev: R, undec: U, contRateDecided: contRate, shortExp: exp(allShort), shortN: allShort.length } };
  await mkdir(dirname("data/bounceresolve.json"), { recursive: true });
  await writeFile("data/bounceresolve.json", JSON.stringify(out, null, 2), "utf8");
  console.log("\nSaved → data/bounceresolve.json");
}

main().catch((e) => {
  console.error(`bounceresolve failed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
