import "./env.js";
import { config } from "./config.js";
import { WARMUP, fetchDeepHistory, precomputeSignals } from "./alphacore.js";
import { atr } from "./indicators.js";
import type { Candle } from "./types.js";

/**
 * `npm run rrsweep` — sweeps the EXIT target on the 4h book (the one candidate edge). For every signal we OVERRIDE
 * the strategy's own target with a fixed R:R multiple (1/1.5/2/2.5/3/4 × the stop distance) and also test a TRAILING
 * exit, then report expectancy + win% per target, NET of taker fees, with a 70/30 OOS split. Higher targets → lower
 * win% but bigger payoff; this finds where expectancy peaks. CAVEAT: this is IN-SAMPLE optimization on the same 4h
 * window the marginal edge was found in — treat a "best" target as a hypothesis to forward-test, not a proven knob.
 */

const SYMBOLS = (process.env.RR_SYMBOLS ?? "SOLUSDT,BTCUSDT,ETHUSDT").split(",").map((s) => s.trim()).filter(Boolean);
const TF = process.env.RR_TF ?? "4h";
const DAYS = Number(process.env.RR_DAYS ?? 2000);
const HORIZON = 48;
const FEE = Number(process.env.FEE_BPS ?? config.paper.feeBps) / 10000;
const TARGETS = [1, 1.5, 2, 2.5, 3, 4];

interface Sig { entry: number; stop: number; long: boolean; atrVal: number; future: Candle[]; openMs: number }

/** Fixed R:R exit → net R (win = +m, loss = −1, timeout = close-based), minus round-trip fee in R. */
function fixedExit(s: Sig, m: number): number {
  const risk = Math.abs(s.entry - s.stop);
  if (risk <= 0) return 0;
  const target = s.long ? s.entry + m * risk : s.entry - m * risk;
  for (const c of s.future) {
    if (s.long ? c.low <= s.stop : c.high >= s.stop) return -1 - FEE * ((s.entry + s.stop) / risk);
    if (s.long ? c.high >= target : c.low <= target) return m - FEE * ((s.entry + target) / risk);
  }
  const last = s.future[s.future.length - 1];
  if (!last) return 0;
  const r = (s.long ? last.close - s.entry : s.entry - last.close) / risk;
  return r - FEE * ((s.entry + last.close) / risk);
}

/** Trailing exit: initial stop; after +1R move, trail k·ATR behind the peak → net R. */
function trailExit(s: Sig, k: number): number {
  const risk = Math.abs(s.entry - s.stop);
  if (risk <= 0) return 0;
  let curStop = s.stop, peak = s.entry;
  for (const c of s.future) {
    if (s.long) {
      if (c.low <= curStop) return (curStop - s.entry) / risk - FEE * ((s.entry + curStop) / risk);
      peak = Math.max(peak, c.high);
      if (s.atrVal > 0 && (peak - s.entry) / risk >= 1) curStop = Math.max(curStop, peak - k * s.atrVal);
    } else {
      if (c.high >= curStop) return (s.entry - curStop) / risk - FEE * ((s.entry + curStop) / risk);
      peak = Math.min(peak, c.low);
      if (s.atrVal > 0 && (s.entry - peak) / risk >= 1) curStop = Math.min(curStop, peak + k * s.atrVal);
    }
  }
  const last = s.future[s.future.length - 1];
  if (!last) return 0;
  return (s.long ? last.close - s.entry : s.entry - last.close) / risk - FEE * ((s.entry + last.close) / risk);
}

const exp = (rs: number[]) => (rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : NaN);
const win = (rs: number[]) => (rs.length ? (100 * rs.filter((r) => r > 0).length) / rs.length : 0);
const f3 = (e: number) => (Number.isFinite(e) ? `${e >= 0 ? "+" : ""}${e.toFixed(3)}R` : "  —  ");

/** Rolling walk-forward of ONE exit rule over the signal set: strategies are fixed → every window is already OOS,
 *  so this tests whether the exit's net expectancy is STABLE across shifting windows (real) or in-sample luck. */
function walkForward(label: string, rOf: (s: Sig) => number, sigs: Sig[]): void {
  const day = 86_400_000;
  const TRAIN = Number(process.env.WFA_TRAIN_DAYS ?? 180), TEST = Number(process.env.WFA_TEST_DAYS ?? 60);
  const t0 = sigs[0]!.openMs, tN = sigs[sigs.length - 1]!.openMs;
  const pool: number[] = []; let pos = 0, tot = 0;
  for (let ts = t0 + TRAIN * day; ts < tN; ts += TEST * day) {
    const seg = sigs.filter((s) => s.openMs >= ts && s.openMs < ts + TEST * day).map(rOf);
    if (!seg.length) continue;
    tot++; if (exp(seg) > 0) pos++; pool.push(...seg);
  }
  const pooled = exp(pool);
  const verdict = pooled > 0.02 && pos >= Math.ceil(tot * 0.6) ? "SURVIVES — stable across rolling windows"
    : pooled > 0 ? "MARGINAL — pooled + but fold stability weak (<60%); fragile" : "FAILS — negative pooled OOS";
  console.log(`  ${label.padEnd(12)} pooled OOS ${f3(pooled)}  win ${win(pool).toFixed(0)}%  n=${pool.length}  ·  positive folds ${pos}/${tot}  → ${verdict}`);
}

async function main() {
  console.log(`R:R / EXIT SWEEP — ${SYMBOLS.join("/")} @ ${TF}, ~${DAYS}d, NET of ${FEE * 1e4}bps/side\n`);
  const target = Math.ceil(DAYS * (24 / (TF.endsWith("h") ? Number(TF.slice(0, -1)) : 24))) + WARMUP + 100;
  const sigs: Sig[] = [];
  for (const sym of SYMBOLS) {
    const c = await fetchDeepHistory(sym, TF, target);
    if (!c || c.length < WARMUP + 100) continue;
    const sigAt = precomputeSignals(sym, c);
    const busy: Record<string, number> = {};
    for (let i = WARMUP; i < c.length - 1; i++) {
      for (const sg of sigAt[i]!) {
        if ((busy[sg.source] ?? -1) >= i) continue;
        const risk = Math.abs(sg.entry - sg.stop);
        if (risk <= 0) continue;
        const future = c.slice(i + 1, i + 1 + HORIZON);
        busy[sg.source] = i + Math.min(HORIZON, future.length); // approx overlap guard
        sigs.push({ entry: sg.entry, stop: sg.stop, long: sg.long, atrVal: atr(c.slice(Math.max(0, i - 30), i + 1)), future, openMs: c[i]!.closeTime });
      }
    }
  }
  sigs.sort((a, b) => a.openMs - b.openMs);
  const cut = Math.floor(sigs.length * 0.7);
  console.log(`${sigs.length} signals.  Column: net R/trade  win%  [OOS held-out 30%]\n`);
  console.log(`  ${"exit".padEnd(12)}${"n".padStart(6)}${"netR".padStart(11)}${"win%".padStart(7)}${"OOS·test".padStart(12)}`);
  const rows: Record<string, unknown>[] = [];
  for (const m of TARGETS) {
    const all = sigs.map((s) => fixedExit(s, m));
    const te = sigs.slice(cut).map((s) => fixedExit(s, m));
    console.log(`  ${`${m}R target`.padEnd(12)}${String(all.length).padStart(6)}${f3(exp(all)).padStart(11)}${`${win(all).toFixed(0)}%`.padStart(7)}${f3(exp(te)).padStart(12)}`);
    rows.push({ exit: `${m}R`, n: all.length, netR: exp(all), winPct: win(all), oosR: exp(te) });
  }
  for (const k of [2, 3]) {
    const all = sigs.map((s) => trailExit(s, k));
    const te = sigs.slice(cut).map((s) => trailExit(s, k));
    console.log(`  ${`trail ${k}ATR`.padEnd(12)}${String(all.length).padStart(6)}${f3(exp(all)).padStart(11)}${`${win(all).toFixed(0)}%`.padStart(7)}${f3(exp(te)).padStart(12)}`);
    rows.push({ exit: `trail${k}ATR`, n: all.length, netR: exp(all), winPct: win(all), oosR: exp(te) });
  }
  const best = rows.filter((r) => Number.isFinite(r.netR as number)).sort((a, b) => (b.netR as number) - (a.netR as number))[0];
  console.log(`\nBEST in-sample: ${best?.exit} (${f3(best?.netR as number)}) — but its OOS held-out is ${f3(best?.oosR as number)}.`);
  console.log(`READ: pick the target with the best NET *and* a positive OOS column. In-sample optimization — forward-test before trusting.`);

  // Walk-forward the leading exit (trailing-3ATR) vs the base (2R fixed) — is the iter-4 trailing lead real or luck?
  console.log(`\nWALK-FORWARD (rolling ${process.env.WFA_TEST_DAYS ?? 60}d test windows; strategies fixed → every window OOS):`);
  walkForward("trail 3ATR", (s) => trailExit(s, 3), sigs);
  walkForward("2R fixed", (s) => fixedExit(s, 2), sigs);
}

main().catch((e) => { console.error(`rrsweep failed: ${(e as Error).stack ?? e}`); process.exit(1); });
