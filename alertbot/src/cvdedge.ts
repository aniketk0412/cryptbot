import "./env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { WARMUP, alignByTime, fetchDeepHistory, precomputeSignals } from "./alphacore.js";
import type { Candle } from "./types.js";

/**
 * `npm run cvdedge` — does AGGRESSIVE-TAKER FLOW (CVD) have predictive edge on our entries? CVD is free and in every
 * kline: each candle carries `takerBuyVolume` (aggressive buys), so bar delta = 2·takerBuy − volume (net aggressive
 * volume; +buyers lifting offers, −sellers hitting bids). This tests the user's thesis honestly, over full history,
 * net of fees, on the SAME entries the book already takes — we only BUCKET them by a causal CVD feature and compare:
 *
 *   • ALIGNED vs CONTRA — is the signal-bar's net aggressive flow in the trade's direction? (long+buying / short+selling)
 *   • TREND-ALIGNED     — does the trailing N-bar cumulative-CVD slope agree with the trade direction?
 *   • DIVERGENCE        — price extended one way while CVD went the other (classic exhaustion) — does it predict reversal?
 *
 * If an aligned/divergence bucket's expectancy is clearly better, CVD earns a place as an entry FILTER (measure it
 * BEFORE wiring it or putting it on a dashboard). If buckets are ~equal, CVD is noise here — matching the earlier
 * `selectedge`/`chainedge` "flow is mild/redundant" finding. Fixed stop/target exit, net of taker fees, no lookahead
 * (delta/CVD use only candles up to the signal bar). Small per-bucket samples are noisy — read the gap + folds.
 */

const SYMBOLS = config.watchlist;
const TARGET = 6000;
const HORIZON = 48;
const FOLDS = 8;
const CVD_N = Number(process.env.CVD_N ?? 14); // trailing bars for the cumulative-CVD trend
const DIV_M = Number(process.env.DIV_M ?? 10); // window for the price-vs-CVD divergence read
const FEE = Number(process.env.FEE_BPS ?? config.paper.feeBps) / 10000;

/** Net aggressive volume per bar (CVD delta): +ve = aggressive buyers dominate. */
function deltaOf(c: Candle): number { return 2 * c.takerBuyVolume - c.volume; }

function exitFixedNet(long: boolean, entry: number, stop: number, target: number, fut: Candle[]): number | null {
  const risk = Math.abs(entry - stop); if (risk <= 0) return null;
  const rt = Math.abs(target - entry) / risk;
  for (const k of fut) {
    if (long ? k.low <= stop : k.high >= stop) { const exit = stop; return -1 - (FEE * (entry + exit)) / risk; }
    if (long ? k.high >= target : k.low <= target) { const exit = target; return rt - (FEE * (entry + exit)) / risk; }
  }
  const last = fut[fut.length - 1]; if (!last) return 0;
  const g = (long ? last.close - entry : entry - last.close) / risk;
  return g - (FEE * (entry + last.close)) / risk;
}

interface Rec { openMs: number; symbol: string; src: string; long: boolean; net: number; aligned: boolean; trendAligned: boolean; divergent: boolean; divAgainst: boolean }

async function build(): Promise<Rec[]> {
  const raw: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) { const c = await fetchDeepHistory(s, config.interval, TARGET); if (c && c.length >= WARMUP + 400) raw[s] = c; else console.error(`  skip ${s}: ${c?.length ?? 0}`); }
  const syms = Object.keys(raw); const bySym = alignByTime(raw, syms);
  const recs: Rec[] = [];
  for (const sym of syms) {
    const c = bySym[sym]!; const n = c.length;
    const sigAt = precomputeSignals(sym, c);
    // causal cumulative CVD
    const cum = new Array<number>(n).fill(0);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1]! + deltaOf(c[i]!);
    const busy: Record<string, number> = {};
    for (let i = WARMUP; i < n - 1; i++) {
      const sigs = sigAt[i]!; if (!sigs.length) continue;
      const bar = c[i]!;
      const dr = bar.volume > 0 ? deltaOf(bar) / bar.volume : 0; // signal-bar net-aggressive ratio ∈ [-1,1]
      const cvdSlope = i >= CVD_N ? cum[i]! - cum[i - CVD_N]! : 0; // trailing CVD trend
      // divergence over DIV_M bars: price direction vs cumulative-CVD direction disagree
      const priceChg = i >= DIV_M ? bar.close - c[i - DIV_M]!.close : 0;
      const cvdChg = i >= DIV_M ? cum[i]! - cum[i - DIV_M]! : 0;
      const divergent = i >= DIV_M && Math.sign(priceChg) !== 0 && Math.sign(cvdChg) !== 0 && Math.sign(priceChg) !== Math.sign(cvdChg);
      for (const sg of sigs) {
        if ((busy[sg.source] ?? -1) >= i) continue;
        const fut = c.slice(i + 1, i + 1 + HORIZON);
        const net = exitFixedNet(sg.long, sg.entry, sg.stop, sg.target, fut);
        if (net === null) continue;
        busy[sg.source] = i + 1;
        const aligned = sg.long ? dr > 0 : dr < 0;
        const trendAligned = sg.long ? cvdSlope > 0 : cvdSlope < 0;
        // "divergence against the trade" = CVD pointing opposite to the trade direction while price extended with it
        const divAgainst = divergent && (sg.long ? cvdChg < 0 : cvdChg > 0);
        recs.push({ openMs: bar.closeTime, symbol: sym, src: sg.source, long: sg.long, net, aligned, trendAligned, divergent, divAgainst });
      }
    }
  }
  recs.sort((a, b) => a.openMs - b.openMs);
  return recs;
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const win = (a: number[]) => (a.length ? (100 * a.filter((r) => r > 0).length) / a.length : 0);
const f3 = (e: number) => (Number.isFinite(e) ? `${e >= 0 ? "+" : ""}${e.toFixed(3)}R` : "  —  ");

function foldsPos(recs: Rec[], t0: number, span: number): string {
  const fold: number[][] = Array.from({ length: FOLDS }, () => []);
  for (const r of recs) fold[Math.min(FOLDS - 1, Math.floor(((r.openMs - t0) / span) * FOLDS))]!.push(r.net);
  const fin = fold.filter((f) => f.length).length, pos = fold.filter((f) => f.length && mean(f) > 0).length;
  return `${pos}/${fin}`;
}

async function main() {
  console.log(`CVD EDGE — does aggressive-taker flow predict our entries' outcomes? ${SYMBOLS.join("/")} @ ${config.interval}`);
  console.log(`signal-bar net-flow ratio · trailing ${CVD_N}-bar CVD trend · ${DIV_M}-bar price-vs-CVD divergence · net ${(FEE * 1e4).toFixed(1)}bps · fixed stop/target\n`);
  const recs = await build();
  if (recs.length < 100) { console.error(`only ${recs.length} entries. Aborting.`); process.exit(1); }
  const t0 = recs[0]!.openMs, span = (recs[recs.length - 1]!.openMs - t0) || 1;

  const bucket = (label: string, subset: Rec[]) => {
    const v = subset.map((r) => r.net);
    console.log(`   ${label.padEnd(26)} ${f3(mean(v)).padStart(9)}   win ${win(v).toFixed(0).padStart(3)}%   folds+ ${foldsPos(subset, t0, span).padStart(5)}   n=${subset.length}`);
    return { net: mean(v), win: win(v), n: subset.length };
  };

  console.log(`── ALL vs FLOW ALIGNMENT (signal-bar aggressive flow in the trade's direction?) ──`);
  const all = bucket("ALL entries (baseline)", recs);
  const al = bucket("flow ALIGNED", recs.filter((r) => r.aligned));
  const co = bucket("flow CONTRA", recs.filter((r) => !r.aligned));
  console.log(`\n── TRAILING CVD-TREND ALIGNMENT (${CVD_N}-bar cumulative CVD agrees with the trade?) ──`);
  const tal = bucket("trend ALIGNED", recs.filter((r) => r.trendAligned));
  const tco = bucket("trend CONTRA", recs.filter((r) => !r.trendAligned));
  console.log(`\n── DIVERGENCE (price extended, CVD disagreed) ──`);
  const dv = bucket("divergent (any)", recs.filter((r) => r.divergent));
  const nd = bucket("no divergence", recs.filter((r) => !r.divergent));
  const da = bucket("CVD-AGAINST the trade", recs.filter((r) => r.divAgainst));

  console.log(`\n── BY STRATEGY (aligned vs contra) ──`);
  for (const src of [...new Set(recs.map((r) => r.src))]) {
    const s = recs.filter((r) => r.src === src);
    const a = s.filter((r) => r.aligned).map((r) => r.net), cc = s.filter((r) => !r.aligned).map((r) => r.net);
    console.log(`   ${src.padEnd(18)} aligned ${f3(mean(a)).padStart(9)} (n=${a.length})   contra ${f3(mean(cc)).padStart(9)} (n=${cc.length})`);
  }

  const edge = al.net - co.net;
  console.log(`\n=== VERDICT @ ${config.interval} ===`);
  const verdict = !Number.isFinite(edge) ? "insufficient data"
    : Math.abs(edge) < 0.02 ? `CVD alignment is ~NOISE here (aligned ${f3(al.net)} vs contra ${f3(co.net)}, gap ${f3(edge)}) — no usable filter edge, matches selectedge/chainedge`
    : edge > 0 ? `flow-ALIGNED entries beat contra by ${f3(edge)}/trade (${f3(co.net)}→${f3(al.net)}) — CVD is a candidate ENTRY FILTER worth forward-testing`
    : `flow-CONTRA beat aligned by ${f3(-edge)} — counterintuitive; treat as noise/overfit unless it holds per-strategy & OOS`;
  console.log(`   ${verdict}.`);
  console.log(`   HONEST: bucketing existing entries, net of fees, fixed exit. A gap here is a FILTER candidate (avoids bad trades),`);
  console.log(`   not a new edge — and must survive per-strategy + fold checks before it's wired or shown as a "signal". Forward-test.\n`);

  await mkdir(dirname("data/cvdedge.json"), { recursive: true });
  await writeFile("data/cvdedge.json", JSON.stringify({
    generatedAt: new Date().toISOString(), symbols: SYMBOLS, interval: config.interval, entries: recs.length,
    all, aligned: al, contra: co, trendAligned: tal, trendContra: tco, divergent: dv, noDiv: nd, cvdAgainst: da, alignEdge: edge,
  }, null, 2), "utf8");
  console.log("Saved → data/cvdedge.json");
}

main().catch((e) => { console.error(`cvdedge failed: ${(e as Error).stack ?? e}`); process.exit(1); });
