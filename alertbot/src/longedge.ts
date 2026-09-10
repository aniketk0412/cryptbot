import "./env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { WARMUP, alignByTime, fetchDeepHistory, mean } from "./alphacore.js";
import { buildConfirmPlan } from "./plan.js";
import { detectRange } from "./range.js";
import { confirmsResistance, confirmsSupport } from "./signals.js";
import { STRATEGIES } from "./strategies.js";
import type { Candle } from "./types.js";

/**
 * `npm run longedge` — is there ANY exploitable LONG-side edge, or is the bull/flat bleed a dead end?
 *
 * `npm run regimealpha`/`regimeoverlay` proved the bot only earns by SHORTING downtrends and loses in
 * bull/flat markets. Before anyone tries to BUILD a long strategy, this measures whether one is even
 * feasible: over deep history it buckets every signal's fixed-R outcome by (source × market-regime ×
 * direction) and asks — does any LONG source have positive expectancy in BULL or FLAT regimes? If yes,
 * there's something to build on; if every long source is ≤0 there, longs are a dead end on this
 * universe/timeframe and the bot should stay short-only. SHORT expectancy is shown for contrast (it
 * should confirm the bear edge). Market regime is the same causal basket signal the live filter uses.
 * No lookahead (signal at i judged on candles > i); per-source busy-gate avoids double-counting a
 * persistent setup. In-sample, one path — directional evidence.
 */

const SYMBOLS = config.watchlist;
const TARGET = 6000;
const HORIZON = 48;          // bars to resolve each trade (fixed target/stop)
const LOOKBACK = 250;        // trailing candles fed to detectors (≥ live candleHistory 150)
const L = config.strategies.marketRegimeLookback;
const BAND = config.strategies.marketRegimeBandPct / 100;
const MIN_N = 12;            // ignore source×regime cells with fewer samples (too noisy)

type Regime = "bull" | "bear" | "flat";
interface Sig { source: string; long: boolean; entry: number; stop: number; target: number }

/** Signals at the newest candle of `window`, keeping the SOURCE name (mirrors the paper engine's set). */
function signalsWithSource(symbol: string, window: Candle[]): Sig[] {
  const out: Sig[] = [];
  const last = window[window.length - 1]!;
  if (config.paper.takeStrategies) {
    const ctx = { symbol, closed: window, price: last.close };
    for (const strat of STRATEGIES) {
      if (!strat.enabled()) continue;
      const s = strat.detect(ctx);
      if (!s) continue;
      const risk = Math.abs(s.entry - s.stop);
      const reward = Math.abs(s.target - s.entry);
      if (risk <= 0 || reward / risk < config.paper.minRR) continue;
      out.push({ source: s.strategy, long: s.direction === "LONG", entry: s.entry, stop: s.stop, target: s.target });
    }
  }
  if (config.paper.takeConfirmations) {
    const range = detectRange(window);
    if (range.consolidating) {
      let level: "support" | "resistance" | null = null;
      if (confirmsSupport(last, range)) level = "support";
      else if (confirmsResistance(last, range)) level = "resistance";
      if (level) {
        const p = buildConfirmPlan(level, range, last.close, true);
        const risk = Math.abs(p.entry - p.stop);
        const reward = Math.abs(p.target - p.entry);
        if (risk > 0 && reward / risk >= config.paper.minRR) out.push({ source: `confirm-${level}`, long: p.direction === "LONG", entry: p.entry, stop: p.stop, target: p.target });
      }
    }
  }
  return out;
}

/** First-touch fixed-R outcome + how many bars until it resolved (for the busy-gate). No lookahead. */
function fixedR(long: boolean, entry: number, stop: number, target: number, future: Candle[]): { r: number; exitBar: number } {
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return { r: 0, exitBar: future.length };
  for (let j = 0; j < future.length; j++) {
    const c = future[j]!;
    if (long) {
      if (c.low <= stop) return { r: -1, exitBar: j + 1 };
      if (c.high >= target) return { r: (target - entry) / risk, exitBar: j + 1 };
    } else {
      if (c.high >= stop) return { r: -1, exitBar: j + 1 };
      if (c.low <= target) return { r: (entry - target) / risk, exitBar: j + 1 };
    }
  }
  const last = future[future.length - 1];
  return { r: last ? (long ? last.close - entry : entry - last.close) / risk : 0, exitBar: future.length };
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(3)}R`;

async function main() {
  console.log(`LONG-SIDE FEASIBILITY — is there any long edge in bull/flat, or a dead end? ${SYMBOLS.join("/")} @ ${config.interval}\n`);
  const raw: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) {
    const c = await fetchDeepHistory(s, config.interval, TARGET);
    if (!c || c.length < L + WARMUP + 300) { console.error(`not enough history for ${s} (${c?.length ?? 0})`); process.exit(1); }
    raw[s] = c;
  }
  const bySym = alignByTime(raw, SYMBOLS);
  const n = bySym[SYMBOLS[0]!]!.length;

  // Causal market regime from the equal-weight basket index (same signal the live filter uses).
  const idx: number[] = [1];
  for (let i = 1; i < n; i++) {
    let r = 0;
    for (const s of SYMBOLS) { const c = bySym[s]!; r += c[i]!.close / c[i - 1]!.close - 1; }
    idx[i] = idx[i - 1]! * (1 + r / SYMBOLS.length);
  }
  const regimeAt: Regime[] = [];
  for (let i = 0; i < n; i++) regimeAt[i] = i < L ? "flat" : ((idx[i]! / idx[i - L]! - 1) > BAND ? "bull" : (idx[i]! / idx[i - L]! - 1) < -BAND ? "bear" : "flat");

  // buckets[source][regime][dir] = R samples
  const buckets: Record<string, Record<Regime, { long: number[]; short: number[] }>> = {};
  const ensure = (src: string) => (buckets[src] ??= { bull: { long: [], short: [] }, bear: { long: [], short: [] }, flat: { long: [], short: [] } });

  for (const sym of SYMBOLS) {
    const closed = bySym[sym]!;
    const busy: Record<string, number> = {};
    for (let i = WARMUP; i < n - 1; i++) {
      const window = closed.slice(Math.max(0, i - LOOKBACK + 1), i + 1);
      const sigs = signalsWithSource(sym, window);
      if (!sigs.length) continue;
      const future = closed.slice(i + 1, i + 1 + HORIZON);
      const reg = regimeAt[i]!;
      for (const sig of sigs) {
        if ((busy[sig.source] ?? -1) >= i) continue;
        const { r, exitBar } = fixedR(sig.long, sig.entry, sig.stop, sig.target, future);
        busy[sig.source] = i + exitBar;
        ensure(sig.source)[reg][sig.long ? "long" : "short"].push(r);
      }
    }
  }

  const exp = (rs: number[]) => (rs.length ? mean(rs) : NaN);
  const cell = (rs: number[]) => (rs.length ? `${pct(exp(rs))}/${rs.length}` : `—`);
  const sources = Object.keys(buckets).sort();

  const table = (dir: "long" | "short", title: string) => {
    console.log(`\n${title}  (expectancy R/trade · n; cells with n<${MIN_N} are noise):`);
    console.log(`  source                 ${["bull", "bear", "flat"].map((r) => r.padStart(14)).join("")}`);
    for (const src of sources) {
      const cells = (["bull", "bear", "flat"] as Regime[]).map((r) => cell(buckets[src]![r][dir]));
      if (cells.every((c) => c === "—")) continue;
      console.log(`  ${src.padEnd(20)} ${cells.map((c) => c.padStart(14)).join("")}`);
    }
  };
  table("long", "LONG side");
  table("short", "SHORT side (contrast — should carry the bear edge)");

  // ---- The verdict: is any LONG source +EV (with enough samples) in BULL or FLAT? ----
  const longWinners: string[] = [];
  for (const src of sources) {
    for (const r of ["bull", "flat"] as Regime[]) {
      const rs = buckets[src]![r].long;
      if (rs.length >= MIN_N && exp(rs) > 0.05) longWinners.push(`${src} in ${r} (${pct(exp(rs))}, n=${rs.length})`);
    }
  }
  const allLongBullFlat = sources.flatMap((s) => [...buckets[s]!.bull.long, ...buckets[s]!.flat.long]);
  console.log(`\nAll long signals in bull+flat combined: ${cell(allLongBullFlat)} expectancy.`);
  console.log(
    `\nVERDICT: ${longWinners.length
      ? `A long-side edge MAY be salvageable — these sources are +EV in up/flat markets:\n  • ${longWinners.join("\n  • ")}\n  Worth prototyping a long strategy around them (then validate forward).`
      : `NO long source is meaningfully +EV in bull or flat regimes (all ≤ +0.05R at n≥${MIN_N}). The long side looks like a DEAD END on this universe/timeframe — the honest path is to stay SHORT-ONLY (enable marketRegimeFilter) rather than force longs. Re-check on other timeframes/symbols before concluding for good.`}`,
  );
  console.log(`\n⚠ In-sample, one path, fixed ${HORIZON}-bar horizon; expectancy is pre-fee gross R. Directional evidence — forward-test before trusting.`);

  const out = { generatedAt: new Date().toISOString(), symbols: SYMBOLS, interval: config.interval, horizon: HORIZON, regimeL: L, band: BAND,
    buckets: Object.fromEntries(sources.map((s) => [s, { bull: { long: exp(buckets[s]!.bull.long), longN: buckets[s]!.bull.long.length, short: exp(buckets[s]!.bull.short), shortN: buckets[s]!.bull.short.length },
      bear: { long: exp(buckets[s]!.bear.long), longN: buckets[s]!.bear.long.length, short: exp(buckets[s]!.bear.short), shortN: buckets[s]!.bear.short.length },
      flat: { long: exp(buckets[s]!.flat.long), longN: buckets[s]!.flat.long.length, short: exp(buckets[s]!.flat.short), shortN: buckets[s]!.flat.short.length } }])),
    longWinners };
  await mkdir(dirname("data/longedge.json"), { recursive: true });
  await writeFile("data/longedge.json", JSON.stringify(out, null, 2), "utf8");
  console.log("\nSaved → data/longedge.json");
}

main().catch((e) => {
  console.error(`longedge failed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
