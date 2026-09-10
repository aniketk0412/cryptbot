import "./env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { WARMUP, alignByTime, fetchDeepHistory, precomputeSignals } from "./alphacore.js";
import { volSpikeBlocks } from "./paperexit.js";
import type { Candle } from "./types.js";

/**
 * `npm run bookwalk` — WALK-FORWARD of the whole book. Does the account's edge (its expectancy, avg R/trade)
 * HOLD across time, out-of-sample, or is it just a lucky window?
 *
 * The live paper strategy account shows a small positive expectancy on ~a dozen trades. This is the honest
 * stress-test: replay the SAME signal book the account trades (`signalsAt` = enabled strategies + S/R
 * confirmations, same minRR) over a long history, split into chronological FOLDS, and report each fold's
 * expectancy + win rate. Because the strategies are FIXED (never fitted to the data), every fold is
 * out-of-sample by construction — so a positive-and-stable expectancy across folds is real evidence the edge
 * generalises; one that flips sign fold-to-fold is regime-luck and shouldn't be trusted or sized up.
 *
 * Two books, mirroring the two live accounts:
 *   • strategy (unfiltered) — every signal, every regime (this is the +0.1R account).
 *   • filtered (bear-only)  — only signals whose causal basket regime is a downtrend (the measured-best config).
 *
 * Honest model: first-touch fixed stop/target (the measured-best exit), NET of taker fees (feeBps/side) —
 * so the R is directly comparable to the account's. No BE/partial modeled. No lookahead. Small per-fold
 * samples are noisy — read the trend across folds, not the third decimal.
 */

const SYMBOLS = config.watchlist;
const TARGET = 6000; // ~250 days of 1h history per symbol
const HORIZON = 48;
const FOLDS = 8;
const L = config.strategies.marketRegimeLookback;
const BAND = config.strategies.marketRegimeBandPct / 100;
const FEE = Number(process.env.FEE_BPS ?? config.paper.feeBps) / 10000; // FEE_BPS env override to test maker (≈2bps) vs taker (5bps) vs rebate (0)

/** First-touch fixed stop/target → gross R and exit bar. */
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

interface Trade { openMs: number; r: number; gross: number; feeUnit: number; inBear: boolean; symbol: string; spike: boolean }

/** Wilder-ATR series: atrAt[i] = trailing ATR using candles[0..i] (matches `atr(closed, lb)` at the moment bar i closed). */
function atrSeries(c: Candle[], lb: number): number[] {
  const out = new Array<number>(c.length).fill(NaN);
  if (lb < 1) return out;
  const trs = new Array<number>(c.length).fill(NaN);
  for (let i = 1; i < c.length; i++) { const h = c[i]!.high, l = c[i]!.low, pc = c[i - 1]!.close; trs[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)); }
  let a = NaN;
  for (let i = lb; i < c.length; i++) {
    if (i === lb) { let s = 0; for (let k = 1; k <= lb; k++) s += trs[k]!; a = s / lb; }
    else a = (a * (lb - 1) + trs[i]!) / lb;
    out[i] = a;
  }
  return out;
}

async function buildTrades(): Promise<Trade[]> {
  const raw: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) {
    const c = await fetchDeepHistory(s, config.interval, TARGET);
    if (!c || c.length < WARMUP + 400) { console.error(`  skip ${s}: only ${c?.length ?? 0} candles`); continue; }
    raw[s] = c;
  }
  const syms = Object.keys(raw);
  const bySym = alignByTime(raw, syms);
  const n = bySym[syms[0]!]!.length;
  const idx: number[] = [1];
  for (let i = 1; i < n; i++) { let r = 0; for (const s of syms) { const c = bySym[s]!; r += c[i]!.close / c[i - 1]!.close - 1; } idx[i] = idx[i - 1]! * (1 + r / syms.length); }
  const bear = (i: number) => i >= L && idx[i]! / idx[i - L]! - 1 < -BAND;

  const VLB = config.paper.volFilter.atrLookback, VMULT = config.paper.volFilter.spikeMult;
  const trades: Trade[] = [];
  for (const sym of syms) {
    const c = bySym[sym]!;
    const sigAt = precomputeSignals(sym, c);
    const atrAt = atrSeries(c, VLB); // trailing ATR as of each bar, for the vol-spike tag
    const busy: Record<string, number> = {};
    for (let i = WARMUP; i < n - 1; i++) {
      // Would the opt-in vol filter have skipped this entry? Bar i is the just-closed candle the signal fires on.
      const spike = volSpikeBlocks(true, c[i]!.high - c[i]!.low, atrAt[i]!, VMULT);
      for (const sg of sigAt[i]!) {
        if ((busy[sg.source] ?? -1) >= i) continue;
        const risk = Math.abs(sg.entry - sg.stop);
        if (risk <= 0) continue;
        const future = c.slice(i + 1, i + 1 + HORIZON);
        const { r, exitBar } = exitFixed(sg.long, sg.entry, sg.stop, sg.target, future);
        busy[sg.source] = i + exitBar;
        const exit = sg.long ? sg.entry + r * risk : sg.entry - r * risk;
        const feeUnit = (sg.entry + exit) / risk; // fee-in-R per unit fee-rate → net at any fee = gross - (bps/1e4)*feeUnit
        const netR = r - FEE * feeUnit; // subtract taker fees (both legs) in R units — matches the paper engine
        trades.push({ openMs: c[i]!.closeTime, r: netR, gross: r, feeUnit, inBear: bear(i), symbol: sym, spike });
      }
    }
    console.log(`  ${sym}: ${trades.filter(() => true).length} cumulative signals`);
  }
  trades.sort((a, b) => a.openMs - b.openMs);
  return trades;
}

interface Cell { n: number; winRate: number; exp: number }
const cell = (rs: number[]): Cell => ({ n: rs.length, winRate: rs.length ? (rs.filter((r) => r > 0).length / rs.length) * 100 : 0, exp: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : NaN });

async function main() {
  console.log(`BOOK WALK-FORWARD — does the account's expectancy hold out-of-sample? ${SYMBOLS.join("/")} @ ${config.interval}\n`);
  const trades = await buildTrades();
  if (trades.length < FOLDS * 5) { console.error(`\nonly ${trades.length} trades — too few to walk. Aborting.`); process.exit(1); }
  const t0 = trades[0]!.openMs, t1 = trades[trades.length - 1]!.openMs;
  const span = (t1 - t0) || 1;
  const foldOf = (ms: number) => Math.min(FOLDS - 1, Math.floor(((ms - t0) / span) * FOLDS));
  const daysPerFold = Math.round(span / FOLDS / 86_400_000);

  const books: { key: "all" | "bear"; label: string; pred: (t: Trade) => boolean }[] = [
    { key: "all", label: "STRATEGY (unfiltered — the +0.1R account)", pred: () => true },
    { key: "bear", label: "FILTERED (bear-only — measured-best)", pred: (t) => t.inBear },
  ];

  console.log(`\n${trades.length} trades over ~${Math.round(span / 86_400_000)} days, ${FOLDS} chronological folds (~${daysPerFold}d each), NET of ${config.paper.feeBps}bps/side fees.`);
  console.log(`Every fold is out-of-sample (fixed strategies, never fitted). Robust edge = expectancy positive & stable across folds.\n`);

  const out: Record<string, unknown> = { generatedAt: new Date().toISOString(), symbols: SYMBOLS, interval: config.interval, trades: trades.length, folds: FOLDS, daysPerFold };
  for (const book of books) {
    const sub = trades.filter(book.pred);
    const folds: number[][] = Array.from({ length: FOLDS }, () => []);
    for (const t of sub) folds[foldOf(t.openMs)]!.push(t.r);
    const cells = folds.map(cell);
    const overall = cell(sub.map((t) => t.r));
    const grossExp = sub.length ? sub.reduce((a, t) => a + t.gross, 0) / sub.length : NaN;
    const feeDrag = grossExp - overall.exp;
    const posFolds = cells.filter((c) => Number.isFinite(c.exp) && c.exp > 0).length;
    const finite = cells.filter((c) => Number.isFinite(c.exp)).length;
    console.log(`── ${book.label} ──`);
    console.log(`   ${Array.from({ length: FOLDS }, (_, f) => `f${f + 1}`).map((h) => h.padStart(9)).join("")}`);
    console.log(`R  ${cells.map((c) => (Number.isFinite(c.exp) ? (c.exp >= 0 ? "+" : "") + c.exp.toFixed(2) : "—")).map((s) => s.padStart(9)).join("")}`);
    console.log(`n  ${cells.map((c) => String(c.n)).map((s) => s.padStart(9)).join("")}`);
    const verdict = overall.exp <= 0 ? "NO EDGE net of fees — the raw book doesn't clear costs"
      : posFolds >= Math.ceil(finite * 0.75) ? `HOLDS — expectancy positive in ${posFolds}/${finite} folds`
      : posFolds >= Math.ceil(finite * 0.5) ? `MIXED — positive in ${posFolds}/${finite} folds (fragile/regime-dependent)`
      : `FRAGILE — positive in only ${posFolds}/${finite} folds; likely in-sample luck`;
    console.log(`   → GROSS ${grossExp >= 0 ? "+" : ""}${grossExp.toFixed(3)}R  −fees ${feeDrag.toFixed(3)}R  = NET ${overall.exp >= 0 ? "+" : ""}${overall.exp.toFixed(3)}R · win ${overall.winRate.toFixed(0)}% · n=${overall.n}`);
    console.log(`      ${verdict}\n`);
    out[book.key] = { overall, grossExp, feeDrag, folds: cells };
  }
  // FEE SWEEP — net expectancy per book across fee tiers, from the SAME trades (gross is fee-independent).
  // Cell = net R/trade (folds-positive/total). One run per INTERVAL gives the whole fee × book grid.
  const FEES = [5, 2, 0];
  const sweep: Record<string, unknown> = {};
  console.log(`\n=== FEE SWEEP (net R/trade · folds-positive) @ ${config.interval} ===`);
  console.log(`   ${"book".padEnd(10)}${FEES.map((b) => `${b}bps`.padStart(16)).join("")}`);
  for (const book of books) {
    const sub = trades.filter(book.pred);
    const row = FEES.map((bps) => {
      const f = bps / 10000;
      const net = (t: Trade) => t.gross - f * t.feeUnit;
      const exp = sub.length ? sub.reduce((a, t) => a + net(t), 0) / sub.length : NaN;
      const fld: number[][] = Array.from({ length: FOLDS }, () => []);
      for (const t of sub) fld[foldOf(t.openMs)]!.push(net(t));
      const pos = fld.filter((fr) => fr.length && fr.reduce((a, b) => a + b, 0) / fr.length > 0).length;
      const fin = fld.filter((fr) => fr.length).length;
      return { bps, exp, pos, fin };
    });
    console.log(`   ${book.key.padEnd(10)}${row.map((c) => `${c.exp >= 0 ? "+" : ""}${c.exp.toFixed(3)}(${c.pos}/${c.fin})`.padStart(16)).join("")}`);
    sweep[book.key] = row;
  }
  out.feeSweep = sweep;
  console.log(`(Fixed stop/target exit, no BE/partial. "+0.05(6/8)" = +0.05R/trade net, positive in 6 of 8 OOS folds. Read the trend, not the 3rd decimal.)`);

  // VALIDATION of the UNFILTERED book (the one net-positive at 12h/1d) — is the edge real or luck? Net of 5bps taker.
  const uf = trades;
  const net5 = (t: Trade) => t.gross - 0.0005 * t.feeUnit;
  const expOf = (arr: Trade[]) => (arr.length ? arr.reduce((a, t) => a + net5(t), 0) / arr.length : NaN);
  const f3 = (e: number) => `${e >= 0 ? "+" : ""}${e.toFixed(3)}R`;
  console.log(`\n=== VALIDATION · unfiltered book @ ${config.interval} (net of 5bps taker) ===`);
  console.log(`  PER-SYMBOL (does the edge hold on each, or is one carrying it?):`);
  for (const sym of SYMBOLS) { const a = uf.filter((t) => t.symbol === sym); console.log(`    ${sym.padEnd(10)} ${f3(expOf(a)).padStart(9)}  n=${String(a.length).padStart(4)}  win ${(a.length ? (100 * a.filter((t) => t.gross > 0).length) / a.length : 0).toFixed(0)}%`); }
  const sorted = [...uf].sort((a, b) => a.openMs - b.openMs);
  const cut = Math.floor(sorted.length * 0.7);
  const tr = sorted.slice(0, cut), te = sorted.slice(cut);
  console.log(`  TRAIN/TEST (70/30 by time):  train ${f3(expOf(tr))} (n=${tr.length})   test·held-out ${f3(expOf(te))} (n=${te.length})`);
  const trimmed = [...uf].sort((a, b) => b.gross - a.gross).slice(3);
  console.log(`  OUTLIER (is it a few big trades?):  full ${f3(expOf(uf))} (n=${uf.length})   minus top-3 winners ${f3(expOf(trimmed))} (n=${trimmed.length})`);
  out.validation = {
    perSymbol: Object.fromEntries(SYMBOLS.map((s) => [s, expOf(uf.filter((t) => t.symbol === s))])),
    train: expOf(tr), test: expOf(te), full: expOf(uf), minusTop3: expOf(trimmed),
  };

  // === VOL-SPIKE FILTER (opt-in news proxy) — would skipping spike-candle entries have helped? Net at FEE. ===
  // The filter, when ON, BLOCKS a new entry if the just-closed candle's range > mult×ATR. Here we tag every
  // entry the same way and compare the book WITH those entries (full) vs WITHOUT (filtered). If the skipped
  // bucket's expectancy is clearly worse than what's kept, the guard earns its keep; if not, it only cuts sample.
  const eR = (a: Trade[]) => (a.length ? a.reduce((x, t) => x + t.r, 0) / a.length : NaN);
  const wR = (a: Trade[]) => (a.length ? (100 * a.filter((t) => t.r > 0).length) / a.length : 0);
  const spikeCount = trades.filter((t) => t.spike).length;
  console.log(`\n=== VOL-SPIKE FILTER (opt-in news proxy) @ ${config.interval} — entry candle range > ${config.paper.volFilter.spikeMult}×ATR${config.paper.volFilter.atrLookback} ===`);
  console.log(`  ${spikeCount}/${trades.length} entries (${trades.length ? ((100 * spikeCount) / trades.length).toFixed(1) : "0"}%) fired on a spike candle.`);
  const volOut: Record<string, unknown> = {};
  for (const book of books) {
    const sub = trades.filter(book.pred);
    const kept = sub.filter((t) => !t.spike), skipped = sub.filter((t) => t.spike);
    console.log(`  ── ${book.key} ──  full ${f3(eR(sub))} (n=${sub.length}) → filtered ${f3(eR(kept))} (n=${kept.length}, −${skipped.length})   [skipped bucket: ${skipped.length ? f3(eR(skipped)) : "—"}${skipped.length ? ` · win ${wR(skipped).toFixed(0)}%` : ""}]`);
    volOut[book.key] = { full: eR(sub), filtered: eR(kept), skipped: skipped.length ? eR(skipped) : null, skippedN: skipped.length, skippedWin: skipped.length ? wR(skipped) : null };
  }
  console.log(`  (Guard helps only if the skipped bucket is clearly WORSE than the kept book. Default OFF — this measures, doesn't enable.)`);
  out.volSpike = { spikeMult: config.paper.volFilter.spikeMult, atrLookback: config.paper.volFilter.atrLookback, spikeCount, total: trades.length, books: volOut };

  await mkdir(dirname("data/bookwalk.json"), { recursive: true });
  await writeFile("data/bookwalk.json", JSON.stringify(out, null, 2), "utf8");
  console.log("\nSaved → data/bookwalk.json");
}

main().catch((e) => { console.error(`bookwalk failed: ${(e as Error).stack ?? e}`); process.exit(1); });
