import "./env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { WARMUP, alignByTime, fetchDeepHistory } from "./alphacore.js";
import { pivotHighs, pivotLows } from "./indicators.js";
import type { Candle } from "./types.js";

/**
 * `npm run sniperbt` — tests the user's FULL thesis, entry+exit co-designed: a "sniper" REVERSION entry that fades a
 * rejection of a MAJOR structural level, with a TIGHT stop just beyond the level and a target at the NEAREST opposing
 * level, then trailing the remainder. This is the setup `snipeedge` hinted works (short-at-resistance +trail +0.249R):
 * closest-level targeting only pays when the entry is a level-reaction (tight stop → good R:R), not a mid-trend chase.
 *
 * SETUP (causal, no lookahead — bar i uses only candles 0..i):
 *   • Build a level map from confirmed, clustered pivots (MAJOR = ≥ majorTouches touches).
 *   • SHORT: bar i pokes a major RESISTANCE (high ≥ L·(1−tol)) but CLOSES back below it (a failed break / rejection).
 *   • LONG : bar i pokes a major SUPPORT   (low  ≤ L·(1+tol)) but CLOSES back above it.
 *   • Entry = bar i close (honest confirm fill — not the level, which would be a mirage; see `npm run confirmedge`).
 *   • Stop  = just beyond the rejection extreme (tight). Target = nearest opposing level. Require reward/risk ≥ minRR.
 *   • Exit variants: FIXED (nearest level) and +TRAIL (bank half at the level → breakeven → trail kATR behind peak).
 *
 * Net of fees (entry taker; target=limit/maker, stop=market/taker). Walk-forward folds = OOS by construction (the
 * rule is fixed, never fitted). HONEST: a fade-the-level reversion book is exactly what earlier tests found hard in
 * crypto (assetchar: sub-fee reversion at 1h; bollinger was the biggest drag) — so approach a positive result with
 * skepticism and read the OOS folds, not the headline. Order-book confirmation (the other half of the ask) is
 * forward-test-only: there is no historical L2 book to backtest.
 */

const SYMBOLS = config.watchlist;
const TARGET = 6000;
const HORIZON = 60;
const FOLDS = 8;
const LOOKBACK = Number(process.env.LVL_LOOKBACK ?? 400);
const PIV = Number(process.env.PIV ?? 3);
const CLUSTER = Number(process.env.CLUSTER_PCT ?? 0.4) / 100;
const MAJOR_TOUCHES = Number(process.env.MAJOR_TOUCHES ?? 3);
const POKE_TOL = Number(process.env.POKE_TOL ?? 0.1) / 100; // how far into the level counts as a poke
const STOP_BUF = Number(process.env.STOP_BUF ?? 0.1) / 100; // stop this far beyond the rejection extreme
const MIN_RR = Number(process.env.MIN_RR ?? 1.0); // skip setups whose nearest-level R:R is below this
const MAX_TGT_ATR = Number(process.env.MAX_TGT_ATR ?? 10);
const KATR = config.paper.exit.trailAtrMult || 3;
const FEE = Number(process.env.FEE_BPS ?? config.paper.feeBps) / 10000;
const MAKER = Number(process.env.MAKER_BPS ?? config.paper.feeBps) / 10000;

interface Lvl { price: number; touches: number; major: boolean }

function atrSeries(c: Candle[], lb = 14): number[] {
  const out = new Array<number>(c.length).fill(NaN);
  const trs = new Array<number>(c.length).fill(NaN);
  for (let i = 1; i < c.length; i++) { const h = c[i]!.high, l = c[i]!.low, pc = c[i - 1]!.close; trs[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)); }
  let a = NaN;
  for (let i = lb; i < c.length; i++) { a = i === lb ? trs.slice(1, lb + 1).reduce((s, x) => s + x, 0) / lb : (a * (lb - 1) + trs[i]!) / lb; out[i] = a; }
  return out;
}

function levelsAsOf(c: Candle[], upto: number): Lvl[] {
  const lo = Math.max(0, upto - LOOKBACK);
  const win = c.slice(lo, upto + 1);
  const highs = win.map((k) => k.high), lows = win.map((k) => k.low);
  const confirmed = (idxs: number[]) => idxs.filter((p) => p + PIV <= win.length - 1);
  const pts = [...confirmed(pivotHighs(highs, PIV, PIV)).map((p) => highs[p]!), ...confirmed(pivotLows(lows, PIV, PIV)).map((p) => lows[p]!)].sort((a, b) => a - b);
  if (!pts.length) return [];
  const levels: Lvl[] = []; let bucket: number[] = [pts[0]!];
  const flush = () => { const price = bucket.reduce((s, x) => s + x, 0) / bucket.length; levels.push({ price, touches: bucket.length, major: bucket.length >= MAJOR_TOUCHES }); };
  for (let i = 1; i < pts.length; i++) { if (Math.abs(pts[i]! - bucket[bucket.length - 1]!) / bucket[bucket.length - 1]! <= CLUSTER) bucket.push(pts[i]!); else { flush(); bucket = [pts[i]!]; } }
  flush(); return levels;
}

type Reason = "target" | "stop" | "timeout";
const feeR = (entry: number, exit: number, risk: number, reason: Reason) => (FEE * entry + (reason === "target" ? MAKER : FEE) * exit) / risk;

function fixedNet(long: boolean, entry: number, stop: number, target: number, fut: Candle[]): number {
  const risk = Math.abs(entry - stop); const rt = Math.abs(target - entry);
  for (const k of fut) {
    if (long ? k.low <= stop : k.high >= stop) return -1 - feeR(entry, stop, risk, "stop");
    if (long ? k.high >= target : k.low <= target) return rt / risk - feeR(entry, target, risk, "target");
  }
  const last = fut[fut.length - 1]; if (!last) return 0;
  return (long ? last.close - entry : entry - last.close) / risk - feeR(entry, last.close, risk, "timeout");
}

function trailNet(long: boolean, entry: number, stop: number, firstTarget: number, atr: number, fut: Candle[]): number {
  const risk = Math.abs(entry - stop); const half = 0.5;
  let banked = 0, partialed = false, curStop = stop, peak = entry;
  for (const k of fut) {
    if (long ? k.low <= curStop : k.high >= curStop) { const remR = (long ? curStop - entry : entry - curStop) / risk; return banked + (partialed ? half : 1) * (remR - feeR(entry, curStop, risk, "stop")); }
    if (!partialed && (long ? k.high >= firstTarget : k.low <= firstTarget)) { banked = half * (Math.abs(firstTarget - entry) / risk - feeR(entry, firstTarget, risk, "target")); partialed = true; curStop = entry; }
    peak = long ? Math.max(peak, k.high) : Math.min(peak, k.low);
    if (partialed) { const trail = long ? peak - KATR * atr : peak + KATR * atr; curStop = long ? Math.max(curStop, trail) : Math.min(curStop, trail); }
  }
  const last = fut[fut.length - 1]; if (!last) return banked;
  return banked + (partialed ? half : 1) * ((long ? last.close - entry : entry - last.close) / risk - feeR(entry, last.close, risk, "timeout"));
}

interface Trade { openMs: number; symbol: string; dir: "L" | "S"; fixed: number; trail: number; rr: number }

async function build(): Promise<Trade[]> {
  const raw: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) { const c = await fetchDeepHistory(s, config.interval, TARGET); if (c && c.length >= WARMUP + 400) raw[s] = c; else console.error(`  skip ${s}: ${c?.length ?? 0}`); }
  const syms = Object.keys(raw); const bySym = alignByTime(raw, syms);
  const trades: Trade[] = [];
  for (const sym of syms) {
    const c = bySym[sym]!; const n = c.length; const atr = atrSeries(c, 14);
    let busyUntil = -1;
    for (let i = WARMUP; i < n - 1; i++) {
      if (i <= busyUntil) continue;
      const a = atr[i]!; if (!(a > 0)) continue;
      const lvls = levelsAsOf(c, i); if (!lvls.length) continue;
      const bar = c[i]!; const entry = bar.close;
      const majors = lvls.filter((l) => l.major);
      // SHORT: poked a major resistance above the close and closed back below it.
      const resAbove = majors.filter((l) => l.price > entry).sort((x, y) => x.price - y.price)[0];
      const supBelow = lvls.filter((l) => l.price < entry).sort((x, y) => y.price - x.price)[0];
      if (resAbove && supBelow && bar.high >= resAbove.price * (1 - POKE_TOL) && bar.close < resAbove.price) {
        const stop = Math.max(bar.high, resAbove.price) * (1 + STOP_BUF);
        const target = supBelow.price * (1 + 0.0005);
        const risk = stop - entry, reward = entry - target;
        if (risk > 0 && reward / risk >= MIN_RR && reward <= MAX_TGT_ATR * a) {
          const fut = c.slice(i + 1, i + 1 + HORIZON);
          trades.push({ openMs: bar.closeTime, symbol: sym, dir: "S", fixed: fixedNet(false, entry, stop, target, fut), trail: trailNet(false, entry, stop, target, a, fut), rr: reward / risk });
          busyUntil = i + 1; continue;
        }
      }
      // LONG: poked a major support below the close and closed back above it.
      const supAt = majors.filter((l) => l.price < entry).sort((x, y) => y.price - x.price)[0];
      const resAt = lvls.filter((l) => l.price > entry).sort((x, y) => x.price - y.price)[0];
      if (supAt && resAt && bar.low <= supAt.price * (1 + POKE_TOL) && bar.close > supAt.price) {
        const stop = Math.min(bar.low, supAt.price) * (1 - STOP_BUF);
        const target = resAt.price * (1 - 0.0005);
        const risk = entry - stop, reward = target - entry;
        if (risk > 0 && reward / risk >= MIN_RR && reward <= MAX_TGT_ATR * a) {
          const fut = c.slice(i + 1, i + 1 + HORIZON);
          trades.push({ openMs: bar.closeTime, symbol: sym, dir: "L", fixed: fixedNet(true, entry, stop, target, fut), trail: trailNet(true, entry, stop, target, a, fut), rr: reward / risk });
          busyUntil = i + 1;
        }
      }
    }
  }
  trades.sort((a, b) => a.openMs - b.openMs);
  return trades;
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const win = (a: number[]) => (a.length ? (100 * a.filter((r) => r > 0).length) / a.length : 0);
const f3 = (e: number) => (Number.isFinite(e) ? `${e >= 0 ? "+" : ""}${e.toFixed(3)}R` : "  —  ");

async function main() {
  console.log(`SNIPER REVERSION BACKTEST — fade a rejection of a MAJOR level, tight stop, nearest-level target (+trail). ${SYMBOLS.join("/")} @ ${config.interval}`);
  console.log(`levels ${LOOKBACK}b/pivot±${PIV}/cluster${(CLUSTER * 100).toFixed(2)}%/MAJOR≥${MAJOR_TOUCHES} · poke ${(POKE_TOL * 100).toFixed(2)}% · stopBuf ${(STOP_BUF * 100).toFixed(2)}% · minRR ${MIN_RR} · trail ${KATR}×ATR · fee ${(FEE * 1e4).toFixed(1)}bps\n`);
  const trades = await build();
  if (trades.length < 40) { console.error(`only ${trades.length} sniper setups — too few to trust. (Loosen POKE_TOL / MAJOR_TOUCHES to get more, but watch overfitting.)`); if (trades.length === 0) process.exit(1); }
  const t0 = trades[0]!.openMs, span = (trades[trades.length - 1]!.openMs - t0) || 1;
  const foldStr = (vals: Trade[], pick: (t: Trade) => number) => {
    const fold: number[][] = Array.from({ length: FOLDS }, () => []);
    for (const t of vals) fold[Math.min(FOLDS - 1, Math.floor(((t.openMs - t0) / span) * FOLDS))]!.push(pick(t));
    const fin = fold.filter((f) => f.length).length, pos = fold.filter((f) => f.length && mean(f) > 0).length;
    return `${pos}/${fin}`;
  };
  const fixed = trades.map((t) => t.fixed), trail = trades.map((t) => t.trail);
  console.log(`${trades.length} sniper setups over ~${Math.round(span / 86_400_000)} days · avg R:R ${mean(trades.map((t) => t.rr)).toFixed(2)} · ${trades.filter((t) => t.dir === "S").length} short / ${trades.filter((t) => t.dir === "L").length} long\n`);
  console.log(`── RESULTS (per-trade net R) ──`);
  console.log(`   FIXED  (nearest level)   ${f3(mean(fixed)).padStart(9)}   win ${win(fixed).toFixed(0)}%   folds+ ${foldStr(trades, (t) => t.fixed)}   n=${trades.length}`);
  console.log(`   +TRAIL (bank½ → trail)   ${f3(mean(trail)).padStart(9)}   win ${win(trail).toFixed(0)}%   folds+ ${foldStr(trades, (t) => t.trail)}   n=${trades.length}`);

  console.log(`\n── BY DIRECTION ──`);
  for (const d of ["S", "L"] as const) {
    const s = trades.filter((t) => t.dir === d); if (!s.length) continue;
    console.log(`   ${d === "S" ? "SHORT@resist" : "LONG@support"}   fixed ${f3(mean(s.map((t) => t.fixed))).padStart(9)}   trail ${f3(mean(s.map((t) => t.trail))).padStart(9)}   win ${win(s.map((t) => t.trail)).toFixed(0)}%   n=${s.length}`);
  }
  console.log(`\n── BY SYMBOL (trail) ──`);
  for (const sym of SYMBOLS) { const s = trades.filter((t) => t.symbol === sym); if (s.length) console.log(`   ${sym.padEnd(10)} ${f3(mean(s.map((t) => t.trail))).padStart(9)}   win ${win(s.map((t) => t.trail)).toFixed(0)}%   n=${s.length}`); }

  const cut = Math.floor(trades.length * 0.7);
  const tr = trades.slice(0, cut), te = trades.slice(cut);
  console.log(`\n── TRAIN/TEST (70/30 by time, +trail) ──  train ${f3(mean(tr.map((t) => t.trail)))} (n=${tr.length})   test·held-out ${f3(mean(te.map((t) => t.trail)))} (n=${te.length})`);

  const best = Math.max(mean(fixed), mean(trail));
  console.log(`\n=== VERDICT @ ${config.interval} ===`);
  console.log(`   ${best > 0 ? `Sniper reversion is net-POSITIVE (best ${f3(best)}/trade) — a real lead, forward-test it` : `Sniper reversion is net-NEGATIVE (best ${f3(best)}/trade) — fading levels doesn't clear costs here either`}.`);
  console.log(`   HONEST: ${trades.length < 200 ? `SMALL sample (${trades.length}) — treat as a hint, not proof. ` : ""}fixed rule, never fitted, so folds are OOS. A positive here is a candidate to`);
  console.log(`   forward-test on a new paper account, NOT a validated edge. Order-book confirmation would be added live-only.\n`);

  await mkdir(dirname("data/sniperbt.json"), { recursive: true });
  await writeFile("data/sniperbt.json", JSON.stringify({
    generatedAt: new Date().toISOString(), symbols: SYMBOLS, interval: config.interval,
    params: { LOOKBACK, PIV, CLUSTER, MAJOR_TOUCHES, POKE_TOL, STOP_BUF, MIN_RR, MAX_TGT_ATR, KATR },
    setups: trades.length, avgRR: mean(trades.map((t) => t.rr)),
    fixed: { net: mean(fixed), win: win(fixed) }, trail: { net: mean(trail), win: win(trail) },
    byDir: Object.fromEntries((["S", "L"] as const).map((d) => { const s = trades.filter((t) => t.dir === d); return [d, { net: mean(s.map((t) => t.trail)), n: s.length }]; })),
    trainTrail: mean(tr.map((t) => t.trail)), testTrail: mean(te.map((t) => t.trail)),
  }, null, 2), "utf8");
  console.log("Saved → data/sniperbt.json");
}

main().catch((e) => { console.error(`sniperbt failed: ${(e as Error).stack ?? e}`); process.exit(1); });
