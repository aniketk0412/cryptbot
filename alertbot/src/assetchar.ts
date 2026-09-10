import "./env.js";
import { fetchDeepHistory } from "./alphacore.js";
import type { Candle } from "./types.js";

/**
 * `npx tsx src/assetchar.ts` — ASSET CHARACTER probe. Before bolting on a "famous strategy," measure what each
 * asset actually IS: does it TREND (momentum works) or MEAN-REVERT (fade works)? Does it have session/day
 * structure a 24/7 crypto strategy ignores? This is the measure-don't-guess foundation for "anything for XAUT?".
 *
 * Read-only, no lookahead in the character stats; the rule backtests use close-to-close forward returns
 * (time exit) NET of fees so trend-vs-revert shows up directly without stop/target path dependence.
 */

const SYMBOLS = ["XAUTUSDT", "SOLUSDT", "BTCUSDT", "ETHUSDT"];
const FEE = 0.0005; // 5bps/side taker, matches the paper engine

const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
const sd = (x: number[]) => { const m = mean(x); return Math.sqrt(mean(x.map((v) => (v - m) ** 2))); };
const pct = (x: number) => `${(x * 100 >= 0 ? "+" : "")}${(x * 100).toFixed(3)}%`;

function logRets(c: Candle[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < c.length; i++) r.push(Math.log(c[i]!.close / c[i - 1]!.close));
  return r;
}

/** Return autocorrelation at `lag`. >0 at short lags = trending/momentum; <0 = mean-reverting. */
function autocorr(x: number[], lag: number): number {
  const m = mean(x), n = x.length;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) den += (x[i]! - m) ** 2;
  for (let i = lag; i < n; i++) num += (x[i]! - m) * (x[i - lag]! - m);
  return den ? num / den : NaN;
}

/** Lo–MacKinlay-style variance ratio VR(q): >1 = trending (returns reinforce), <1 = mean-reverting. Heuristic normalization. */
function varianceRatio(x: number[], q: number): number {
  const n = x.length, mu = mean(x);
  let v1 = 0; for (const v of x) v1 += (v - mu) ** 2; v1 /= (n - 1);
  let vq = 0, cnt = 0;
  for (let i = 0; i + q <= n; i++) { let s = 0; for (let k = 0; k < q; k++) s += x[i + k]!; vq += (s - q * mu) ** 2; cnt++; }
  vq /= (cnt * q);
  return v1 > 0 ? vq / v1 : NaN;
}

/** Forward return over H bars entered at bar i's close, signed by `dir` (+1 long / −1 short), net of 2 fee legs. */
function fwd(c: Candle[], i: number, H: number, dir: number): number | null {
  if (i + H >= c.length) return null;
  const gross = dir * (Math.log(c[i + H]!.close / c[i]!.close));
  return gross - 2 * FEE;
}

async function analyze(sym: string) {
  const h1 = await fetchDeepHistory(sym, "1h", 3000);
  const d1 = await fetchDeepHistory(sym, "1d", 500);
  if (!h1 || h1.length < 300) { console.log(`\n### ${sym}: insufficient 1h data (${h1?.length ?? 0})`); return null; }
  const r1 = logRets(h1);
  const rd = d1 && d1.length > 40 ? logRets(d1) : [];
  const days1h = Math.round((h1[h1.length - 1]!.closeTime - h1[0]!.openTime) / 86_400_000);

  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`### ${sym}  —  ${h1.length} × 1h (~${days1h}d)${d1 ? `, ${d1.length} × 1d` : ""}`);

  // 1) TREND vs REVERT signature
  console.log(`\n  TREND vs MEAN-REVERSION signature`);
  console.log(`    1h return autocorr  lag1 ${autocorr(r1, 1).toFixed(3)}  lag2 ${autocorr(r1, 2).toFixed(3)}  lag3 ${autocorr(r1, 3).toFixed(3)}  lag6 ${autocorr(r1, 6).toFixed(3)}`);
  if (rd.length) console.log(`    1d return autocorr  lag1 ${autocorr(rd, 1).toFixed(3)}  lag2 ${autocorr(rd, 2).toFixed(3)}  lag5 ${autocorr(rd, 5).toFixed(3)}`);
  console.log(`    1h variance-ratio   VR2 ${varianceRatio(r1, 2).toFixed(3)}  VR4 ${varianceRatio(r1, 4).toFixed(3)}  VR8 ${varianceRatio(r1, 8).toFixed(3)}   (>1 trend · <1 revert)`);
  // conditional next-candle return
  const up: number[] = [], dn: number[] = [];
  for (let i = 1; i < r1.length; i++) { if (r1[i - 1]! > 0) up.push(r1[i]!); else if (r1[i - 1]! < 0) dn.push(r1[i]!); }
  console.log(`    after UP candle → next ${pct(mean(up))}  ·  after DOWN candle → next ${pct(mean(dn))}   (up→+ & down→− = momentum; up→− & down→+ = reversion)`);
  // volatility clustering: autocorr of squared returns
  console.log(`    vol clustering (autocorr |r|²) lag1 ${autocorr(r1.map((v) => v * v), 1).toFixed(3)}   (high = vol clusters → vol-targeting/breakout-friendly)`);

  // 2) SESSION structure (UTC) — gold should light up London/NY; crypto flatter
  const sessions: Record<string, { ret: number[]; av: number[] }> = { "Asia 00-07": { ret: [], av: [] }, "London 07-13": { ret: [], av: [] }, "NY 13-21": { ret: [], av: [] }, "Late 21-24": { ret: [], av: [] } };
  for (let i = 1; i < h1.length; i++) {
    const hr = new Date(h1[i]!.closeTime).getUTCHours();
    const key = hr < 7 ? "Asia 00-07" : hr < 13 ? "London 07-13" : hr < 21 ? "NY 13-21" : "Late 21-24";
    sessions[key]!.ret.push(r1[i - 1]!); sessions[key]!.av.push(Math.abs(r1[i - 1]!));
  }
  console.log(`\n  SESSION structure (UTC, per-1h-bar mean return · mean |move| = volatility)`);
  for (const [k, v] of Object.entries(sessions)) console.log(`    ${k.padEnd(14)} ret ${pct(mean(v.ret)).padStart(9)}   vol ${pct(mean(v.av)).padStart(9)}   n=${v.ret.length}`);
  // weekend vs weekday
  const wd: number[] = [], we: number[] = [], wdv: number[] = [], wev: number[] = [];
  for (let i = 1; i < h1.length; i++) { const g = new Date(h1[i]!.closeTime).getUTCDay(); const isWe = g === 0 || g === 6; (isWe ? we : wd).push(r1[i - 1]!); (isWe ? wev : wdv).push(Math.abs(r1[i - 1]!)); }
  console.log(`    weekday        ret ${pct(mean(wd)).padStart(9)}   vol ${pct(mean(wdv)).padStart(9)}   n=${wd.length}`);
  console.log(`    weekend        ret ${pct(mean(we)).padStart(9)}   vol ${pct(mean(wev)).padStart(9)}   n=${we.length}   (gold: expect quiet weekends — underlying market closed)`);

  // 3) RULE BACKTESTS (net of fees) — does FADE (reversion) or FOLLOW (momentum) pay on a z-move?
  console.log(`\n  Z-MOVE forward return, NET of fees  (FADE = contrarian; if FADE>0 asset reverts, if FADE<0 it trends)`);
  console.log(`    ${"".padEnd(10)}${[1, 3, 6, 12].map((h) => `H=${h}`.padStart(11)).join("")}`);
  const W = 48; // rolling window for the z-score baseline
  for (const Z of [1.0, 1.5, 2.0]) {
    const row: string[] = [];
    for (const H of [1, 3, 6, 12]) {
      const fade: number[] = [];
      for (let i = W; i < h1.length - H; i++) {
        const win = r1.slice(i - W, i); const s = sd(win); if (!(s > 0)) continue;
        const z = r1[i - 1]! / s; // NB r1[i-1] is the return INTO candle i
        if (z <= -Z) { const f = fwd(h1, i, H, +1); if (f !== null) fade.push(f); }      // dropped hard → FADE = go long
        else if (z >= Z) { const f = fwd(h1, i, H, -1); if (f !== null) fade.push(f); }   // popped hard → FADE = go short
      }
      row.push((fade.length ? `${pct(mean(fade))}·${fade.length}` : "—").padStart(11));
    }
    console.log(`    z≥${Z.toFixed(1)}    ${row.join("")}`);
  }

  // 4) DONCHIAN-20 breakout continuation (turtle/trend) — mean fwd return after a 20-bar high/low break, net fees
  console.log(`\n  DONCHIAN-20 breakout forward return, NET of fees  (trend-follow: >0 = breakouts continue)`);
  console.log(`    ${"".padEnd(10)}${[6, 12, 24, 48].map((h) => `H=${h}`.padStart(11)).join("")}`);
  const N = 20;
  const brk: string[] = [];
  for (const H of [6, 12, 24, 48]) {
    const cont: number[] = [];
    for (let i = N; i < h1.length - H; i++) {
      const hi = Math.max(...h1.slice(i - N, i).map((k) => k.high));
      const lo = Math.min(...h1.slice(i - N, i).map((k) => k.low));
      if (h1[i]!.close > hi) { const f = fwd(h1, i, H, +1); if (f !== null) cont.push(f); }
      else if (h1[i]!.close < lo) { const f = fwd(h1, i, H, -1); if (f !== null) cont.push(f); }
    }
    brk.push((cont.length ? `${pct(mean(cont))}·${cont.length}` : "—").padStart(11));
  }
  console.log(`    break     ${brk.join("")}`);

  return { sym, ac1: autocorr(r1, 1), vr4: varianceRatio(r1, 4) };
}

async function main() {
  console.log(`ASSET CHARACTER — trend vs reversion, session structure, and does fade/follow pay net of fees?`);
  console.log(`Fees: ${FEE * 1e4}bps/side. Character stats have no lookahead; rule tests use close-to-close time exits.`);
  const out: unknown[] = [];
  for (const s of SYMBOLS) { const r = await analyze(s); if (r) out.push(r); }
  console.log(`\n\n══════════ READ-OUT ══════════`);
  console.log(`autocorr(lag1) < 0 and VR4 < 1  → mean-reverting (a FADE strategy fits; RSI2/Bollinger-reversion).`);
  console.log(`autocorr(lag1) > 0 and VR4 > 1  → trending    (a FOLLOW strategy fits; Donchian/momentum/MA-cross).`);
  console.log(`Neither clearly, or rule tests negative net of fees → no cheap edge; fees dominate at 1h.`);
}

main().catch((e) => { console.error(`assetchar failed: ${(e as Error).stack ?? e}`); process.exit(1); });
