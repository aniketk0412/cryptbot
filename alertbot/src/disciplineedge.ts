import "./env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { WARMUP, alignByTime, fetchDeepHistory, precomputeSignals } from "./alphacore.js";
import { disciplineBlocks, type DisciplineCaps } from "./paperexit.js";
import type { Candle } from "./types.js";

/**
 * `npm run disciplineedge` — MEASURE the opt-in paper circuit-breaker (config.paper.discipline).
 *
 * The paper engine takes every qualifying signal and trades straight THROUGH losing streaks / drawdowns; the
 * live shadow HALTS on daily-loss / consecutive-loss / drawdown rails. The `paper.discipline` knob (default OFF)
 * runs those same rails on the paper book. This tool answers "what would turning it on do to the track record?"
 * — it replays every signal into a compounding fake account (same sizing + fee model as the engine) and
 * simulates it with the breaker OFF vs ON, using the SAME `disciplineBlocks()` the engine uses.
 *
 * TWO books, to be honest about WHERE the breaker matters:
 *   • strategy (unfiltered) — every signal in every regime. This book is a STRUCTURAL LOSER (the bot's edge is
 *     only bear-regime shorts; it bleeds in bull/flat), so its returns are negative with or without the breaker
 *     — the breaker just makes the bleed smaller. Shown so the numbers aren't mistaken for "the breaker loses."
 *   • filtered (bear-only) — only signals whose broad-market regime is a (causal, trailing) DOWNTREND, mirroring
 *     the real `filtered` account (marketRegimeBlocks). This is the account with the actual edge and the one the
 *     breaker is recommended for — the meaningful test.
 *
 * Method: no-lookahead first-touch fixed stop/target (stop-first within a bar), per-source busy-gate,
 * maxOpenPerSymbol=1, deep aligned multi-symbol history, causal basket-regime for the bear filter. It does NOT
 * model break-even / partial-TP exit management, so absolute % is a proxy — the honest signal is the OFF-vs-ON
 * DELTA within each book. In-sample, directional evidence only.
 */

const SYMBOLS = config.watchlist;
const TARGET = 6000; // ~250 days of 1h history per symbol
const HORIZON = 48; // bars to resolve a trade
const L = config.strategies.marketRegimeLookback; // basket-regime lookback (bars)
const BAND = config.strategies.marketRegimeBandPct / 100; // downtrend threshold

/** First-touch fixed stop/target. Returns realized R and the bar it exited (for the busy-gate). */
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

interface Trade { openMs: number; closeMs: number; symbol: string; long: boolean; entry: number; riskDist: number; r: number; inBear: boolean }

async function buildStream(): Promise<Trade[]> {
  const raw: Record<string, Candle[]> = {};
  for (const sym of SYMBOLS) {
    const c = await fetchDeepHistory(sym, config.interval, TARGET);
    if (!c || c.length < WARMUP + 400) { console.error(`  skip ${sym}: only ${c?.length ?? 0} candles`); continue; }
    raw[sym] = c;
  }
  const syms = Object.keys(raw);
  if (syms.length < 1) return [];
  const bySym = alignByTime(raw, syms); // shared timeline so a single basket-regime index applies to all
  const n = bySym[syms[0]!]!.length;
  // Causal equal-weight basket index → bear regime = trailing L-bar basket return below -BAND (same as the live filter).
  const idx: number[] = [1];
  for (let i = 1; i < n; i++) {
    let r = 0;
    for (const s of syms) { const c = bySym[s]!; r += c[i]!.close / c[i - 1]!.close - 1; }
    idx[i] = idx[i - 1]! * (1 + r / syms.length);
  }
  const bear = (i: number) => i >= L && idx[i]! / idx[i - L]! - 1 < -BAND;

  const trades: Trade[] = [];
  for (const sym of syms) {
    const c = bySym[sym]!;
    const sigAt = precomputeSignals(sym, c);
    const busy: Record<string, number> = {};
    let count = 0;
    for (let i = WARMUP; i < n - 1; i++) {
      for (const sg of sigAt[i]!) {
        if ((busy[sg.source] ?? -1) >= i) continue; // per-source busy-gate: don't re-count a persistent setup
        const future = c.slice(i + 1, i + 1 + HORIZON);
        const { r, exitBar } = exitFixed(sg.long, sg.entry, sg.stop, sg.target, future);
        busy[sg.source] = i + exitBar;
        const closeIdx = Math.min(i + exitBar, n - 1);
        trades.push({ openMs: c[i]!.closeTime, closeMs: c[closeIdx]!.closeTime, symbol: sym, long: sg.long, entry: sg.entry, riskDist: Math.abs(sg.entry - sg.stop), r, inBear: bear(i) });
        count++;
      }
    }
    console.log(`  ${sym}: ${n} candles → ${count} signals`);
  }
  trades.sort((a, b) => a.openMs - b.openMs);
  return trades;
}

interface SimOut { label: string; retPct: number; finalBal: number; maxDD: number; taken: number; skipped: number; halts: { daily: number; streak: number; drawdown: number } }

/** Compounding account sim over the time-sorted stream. `caps` null = discipline OFF (take every qualifying signal). */
function simulate(label: string, stream: Trade[], caps: DisciplineCaps | null): SimOut {
  const risk = config.paper.riskPct / 100;
  const feeRate = config.paper.feeBps / 10000;
  const start: number = config.paper.startBalanceUsd;
  let balance = start, peak = start, maxDD = 0;
  const closed: { pnlUsd: number; closeTime: string }[] = []; // newest-first (as acc.closed)
  const open: { closeMs: number; symbol: string; pnl: number; iso: string }[] = [];
  let taken = 0, skipped = 0, hDaily = 0, hStreak = 0, hDd = 0;

  const settle = (upToMs: number) => {
    open.sort((a, b) => a.closeMs - b.closeMs);
    while (open.length && open[0]!.closeMs <= upToMs) {
      const t = open.shift()!;
      balance += t.pnl;
      closed.unshift({ pnlUsd: t.pnl, closeTime: t.iso });
      if (balance > peak) peak = balance;
      const dd = peak > 0 ? ((peak - balance) / peak) * 100 : 0;
      if (dd > maxDD) maxDD = dd;
    }
  };

  for (const tr of stream) {
    settle(tr.openMs); // book everything that closed before this entry
    if (open.some((o) => o.symbol === tr.symbol)) continue; // maxOpenPerSymbol = 1 (engine cap, both runs)
    if (caps) {
      const halt = disciplineBlocks(closed, balance, peak, caps, tr.openMs);
      if (halt) { skipped++; halt.startsWith("daily") ? hDaily++ : halt.includes("streak") ? hStreak++ : hDd++; continue; }
    }
    const riskUsd = balance * risk;
    const sizeUnits = tr.riskDist > 0 ? riskUsd / tr.riskDist : 0;
    const exit = tr.long ? tr.entry + tr.r * tr.riskDist : tr.entry - tr.r * tr.riskDist;
    const fees = feeRate * sizeUnits * (tr.entry + exit);
    open.push({ closeMs: tr.closeMs, symbol: tr.symbol, pnl: tr.r * riskUsd - fees, iso: new Date(tr.closeMs).toISOString() });
    taken++;
  }
  settle(Infinity);
  return { label, retPct: (balance / start - 1) * 100, finalBal: balance, maxDD, taken, skipped, halts: { daily: hDaily, streak: hStreak, drawdown: hDd } };
}

function reportBook(title: string, stream: Trade[]): SimOut[] {
  const d = config.paper.discipline;
  const base: DisciplineCaps = { enabled: true, applyTo: [], maxDailyLossUsd: d.maxDailyLossUsd, maxConsecutiveLosses: d.maxConsecutiveLosses, maxDrawdownPct: d.maxDrawdownPct, cooldownHours: d.cooldownHours };
  const configs: { label: string; caps: DisciplineCaps | null }[] = [
    { label: "OFF (baseline — today)", caps: null },
    { label: `ALL rails (${d.maxDailyLossUsd}/${d.maxConsecutiveLosses}/${d.maxDrawdownPct}%)`, caps: base },
    { label: "consecutive-loss only", caps: { ...base, maxDailyLossUsd: 0, maxDrawdownPct: 0 } },
    { label: "daily-loss only", caps: { ...base, maxConsecutiveLosses: 0, maxDrawdownPct: 0 } },
    { label: "drawdown only", caps: { ...base, maxDailyLossUsd: 0, maxConsecutiveLosses: 0 } },
  ];
  const rows = configs.map((c) => simulate(c.label, stream, c.caps));
  const b = rows[0]!;
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(`\n=== ${title} — ${stream.length} trades ===`);
  console.log(`${pad("config", 26)} ${pad("return", 16)} ${pad("maxDD", 15)} ${pad("trades", 7)} skipped`);
  for (const r of rows) {
    const dRet = r === b ? "" : ` (${r.retPct - b.retPct >= 0 ? "+" : ""}${(r.retPct - b.retPct).toFixed(1)})`;
    const dDD = r === b ? "" : ` (${r.maxDD - b.maxDD >= 0 ? "+" : ""}${(r.maxDD - b.maxDD).toFixed(1)})`;
    console.log(`${pad(r.label, 26)} ${pad(`${r.retPct >= 0 ? "+" : ""}${r.retPct.toFixed(1)}%${dRet}`, 16)} ${pad(`${r.maxDD.toFixed(1)}%${dDD}`, 15)} ${pad(String(r.taken), 7)} ${r.skipped}`);
  }
  return rows;
}

async function main() {
  console.log(`DISCIPLINE EDGE — what does turning on paper.discipline do? ${SYMBOLS.join("/")} @ ${config.interval}\n`);
  const stream = await buildStream();
  if (stream.length < 50) { console.error(`\nonly ${stream.length} trades — not enough to measure. Aborting.`); process.exit(1); }
  const bearStream = stream.filter((t) => t.inBear);
  console.log(`\n${stream.length} trades total · ${bearStream.length} in a bear regime (the 'filtered' book).`);

  const strat = reportBook("STRATEGY book (unfiltered — every regime; a STRUCTURAL LOSER by design)", stream);
  const filt = reportBook("FILTERED book (bear-only — the account with the edge; where the breaker is recommended)", bearStream);

  const fb = filt[0]!, fAll = filt[1]!, fStreak = filt[2]!;
  console.log(`\nVERDICT — on the FILTERED book (the one you'd actually run):`);
  console.log(`  baseline ${fb.retPct >= 0 ? "+" : ""}${fb.retPct.toFixed(1)}% / ${fb.maxDD.toFixed(1)}% DD` +
    `  →  ALL-rails ${fAll.retPct >= 0 ? "+" : ""}${fAll.retPct.toFixed(1)}% / ${fAll.maxDD.toFixed(1)}% DD` +
    `  ·  streak-only ${fStreak.retPct >= 0 ? "+" : ""}${fStreak.retPct.toFixed(1)}% / ${fStreak.maxDD.toFixed(1)}% DD`);
  const ddCut = fb.maxDD > 0 ? ((fb.maxDD - fAll.maxDD) / fb.maxDD) * 100 : 0;
  console.log(`  default rails: drawdown ${fAll.maxDD <= fb.maxDD ? "CUT" : "RAISED"} ${Math.abs(ddCut).toFixed(0)}%, return ${fAll.retPct - fb.retPct >= 0 ? "+" : ""}${(fAll.retPct - fb.retPct).toFixed(1)}pp.`);
  console.log(`\n(In-sample, fixed stop/target exit — no BE/partial — fees ${config.paper.feeBps}bps/side. The breaker is a RISK control: it shrinks drawdown/loss, it does not create profit. The STRATEGY book is negative with or without it because that book has no edge — not the breaker's doing.)`);

  const out = { generatedAt: new Date().toISOString(), symbols: SYMBOLS, interval: config.interval, target: TARGET, horizon: HORIZON, streamTrades: stream.length, bearTrades: bearStream.length, caps: config.paper.discipline, strategyBook: strat, filteredBook: filt };
  await mkdir(dirname("data/disciplineedge.json"), { recursive: true });
  await writeFile("data/disciplineedge.json", JSON.stringify(out, null, 2), "utf8");
  console.log("\nSaved → data/disciplineedge.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
