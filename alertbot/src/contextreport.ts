import "./env.js";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { config } from "./config.js";
import { fetchDeepHistory } from "./alphacore.js";
import type { Candle } from "./types.js";

/**
 * `npm run contextreport` — reads the forward-measurement log (`data/context-log.jsonl`, written by
 * `logContextAtSignal` at each signal) and reports WHICH MARKET-CONTEXT CONDITIONS preceded winning trades.
 *
 * This is the honest pay-off of "monitor-first, trade-later": every Tier-1 signal (CVD, funding, OI/LS) MEASURED as
 * noise on history — this tool lets the LIVE record settle it forward. It joins each logged signal to its real outcome
 * (first-touch stop/target from the logged entry/stop/target, net of taker fees, replayed on the correct-timeframe
 * candles) and buckets the resolved trades by funding-crowding / flow-alignment / long-short. It reports win% + avg R
 * per bucket so you can SEE whether, say, "short into crowded longs" is actually paying — over your own forward data.
 *
 * HONEST: descriptive, not an edge claim. The log accumulates from the day you restart the bot, so early on the sample
 * is tiny and noisy — the `fundingsent` regime-artifact lesson applies (a small window lies). Read n before the gap;
 * treat a signal as real only once it holds across a decent sample AND multiple market regimes. Nothing here auto-trades.
 */

const LOG = process.env.CTX_LOG ?? "data/context-log.jsonl";
const FEE = config.paper.feeBps / 10000;
const HORIZON = Number(process.env.CTX_HORIZON ?? 48); // bars to resolve a signal's outcome
const HIST = Number(process.env.CTX_HIST ?? 3000); // candles/timeframe to fetch for replay (covers recent forward log)

interface LogRow {
  t: string; symbol: string; source: string; direction: "LONG" | "SHORT"; entry: number; stop: number; target: number;
  signalCloseTime: number; timeframe: string; funding: number | null; fundingPctl: number | null; oiUsd: number | null; ls: number | null; flowLean: number | null;
}
interface Resolved extends LogRow { r: number; outcome: "win" | "loss" | "pending" }

/**
 * First-touch stop/target from the signal bar, net of taker fees (both legs). "pending" = unresolved within history
 * (too recent, or the signal bar predates the fetched candles). Exported for unit tests. `feeRate` per side.
 */
export function resolveOutcome(row: { direction: "LONG" | "SHORT"; entry: number; stop: number; target: number; signalCloseTime: number }, candles: Candle[], feeRate = FEE, horizon = HORIZON): { r: number; outcome: "win" | "loss" } | { outcome: "pending" } {
  const long = row.direction === "LONG";
  const risk = Math.abs(row.entry - row.stop);
  if (risk <= 0) return { outcome: "pending" };
  const rt = Math.abs(row.target - row.entry) / risk;
  // find the signal bar (closeTime == signalCloseTime), else the first closed bar after it
  let i = candles.findIndex((c) => c.closeTime === row.signalCloseTime);
  if (i < 0) i = candles.findIndex((c) => c.closeTime > row.signalCloseTime) - 1;
  if (i < 0) return { outcome: "pending" }; // signal predates fetched history
  const end = Math.min(candles.length, i + 1 + horizon);
  for (let j = i + 1; j < end; j++) {
    const c = candles[j]!;
    if (long ? c.low <= row.stop : c.high >= row.stop) return { r: -1 - (feeRate * (row.entry + row.stop)) / risk, outcome: "loss" };
    if (long ? c.high >= row.target : c.low <= row.target) return { r: rt - (feeRate * (row.entry + row.target)) / risk, outcome: "win" };
  }
  return { outcome: "pending" }; // hasn't hit stop or target yet (too recent, or ranging)
}

const wins = (a: Resolved[]) => a.filter((x) => x.outcome === "win").length;
const winPct = (a: Resolved[]) => (a.length ? (100 * wins(a)) / a.length : 0);
const avgR = (a: Resolved[]) => (a.length ? a.reduce((s, x) => s + x.r, 0) / a.length : NaN);
const f3 = (e: number) => (Number.isFinite(e) ? `${e >= 0 ? "+" : ""}${e.toFixed(3)}R` : "  —  ");

function bucket(label: string, sub: Resolved[], all: Resolved[]): void {
  const gap = Number.isFinite(avgR(sub)) && Number.isFinite(avgR(all)) ? avgR(sub) - avgR(all) : NaN;
  console.log(`   ${label.padEnd(30)} ${f3(avgR(sub)).padStart(9)}   win ${winPct(sub).toFixed(0).padStart(3)}%   n=${String(sub.length).padStart(4)}   vs-all ${f3(gap)}`);
}

async function main() {
  let raw: string;
  try { raw = await readFile(LOG, "utf8"); }
  catch { console.log(`No forward-log yet at ${LOG}.\n→ Restart the bot (it writes one line per signal), let it run, then re-run this. Come back in a few weeks for a real sample.`); return; }
  const rows: LogRow[] = raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as LogRow; } catch { return null; } }).filter((x): x is LogRow => !!x && typeof x.entry === "number" && typeof x.stop === "number");
  if (!rows.length) { console.log(`Log ${LOG} is empty (or pre-dates the stop/target fields). Restart the bot to collect fresh entries.`); return; }

  // Resolve each signal against its timeframe's candles (fetch each (symbol,tf) once).
  const cache = new Map<string, Candle[]>();
  const resolved: Resolved[] = [];
  for (const row of rows) {
    const key = `${row.symbol}|${row.timeframe}`;
    if (!cache.has(key)) cache.set(key, (await fetchDeepHistory(row.symbol, row.timeframe || "1h", HIST)) ?? []);
    const candles = cache.get(key)!;
    const res = resolveOutcome(row, candles);
    resolved.push({ ...row, r: "r" in res ? res.r : 0, outcome: res.outcome });
  }

  const done = resolved.filter((x) => x.outcome !== "pending");
  const pending = resolved.length - done.length;
  const span = rows.length ? Math.round((Date.parse(rows[rows.length - 1]!.t) - Date.parse(rows[0]!.t)) / 86_400_000) : 0;
  console.log(`FORWARD CONTEXT REPORT — ${resolved.length} logged signals over ~${span} days · ${done.length} resolved · ${pending} still open\n`);
  if (done.length < 10) {
    console.log(`⚠️ Only ${done.length} resolved trades — far too few to read anything into. The log needs weeks of forward data.`);
    console.log(`   (This is expected right after enabling it. Re-run periodically; the buckets below fill in as trades close.)\n`);
  }
  console.log(`OVERALL (resolved):  ${f3(avgR(done))} · win ${winPct(done).toFixed(0)}% · n=${done.length}\n`);

  const withCrowd = done.filter((x) => x.fundingPctl != null && ((x.direction === "LONG" && x.fundingPctl >= 0.8) || (x.direction === "SHORT" && x.fundingPctl <= 0.2)));
  const against = done.filter((x) => x.fundingPctl != null && ((x.direction === "LONG" && x.fundingPctl <= 0.2) || (x.direction === "SHORT" && x.fundingPctl >= 0.8)));
  console.log(`── FUNDING CROWDING (positioning vs the trade) ──`);
  bucket("WITH the crowd", withCrowd, done);
  bucket("AGAINST the crowd (contrarian)", against, done);

  const flowAligned = done.filter((x) => x.flowLean != null && ((x.direction === "LONG" && x.flowLean > 0) || (x.direction === "SHORT" && x.flowLean < 0)));
  const flowContra = done.filter((x) => x.flowLean != null && ((x.direction === "LONG" && x.flowLean < 0) || (x.direction === "SHORT" && x.flowLean > 0)));
  console.log(`\n── AGGRESSIVE FLOW (CVD lean vs the trade) ──`);
  bucket("flow ALIGNED with trade", flowAligned, done);
  bucket("flow CONTRA the trade", flowContra, done);

  const lsLong = done.filter((x) => x.ls != null && x.ls > 1);
  const lsShort = done.filter((x) => x.ls != null && x.ls <= 1);
  console.log(`\n── LONG/SHORT ACCOUNT RATIO ──`);
  bucket("long-heavy book (L/S > 1)", lsLong, done);
  bucket("short-heavy book (L/S ≤ 1)", lsShort, done);

  console.log(`\n── BY SIGNAL SOURCE ──`);
  for (const src of [...new Set(done.map((x) => x.source))]) bucket(src, done.filter((x) => x.source === src), done);

  console.log(`\nHONEST READ: these are DESCRIPTIVE splits of your live forward log, not a validated edge. Watch n and whether a`);
  console.log(`gap persists across weeks + regimes before trusting it — the funding regime-artifact (fundingsent) is the cautionary tale.`);
}

// Only run when invoked directly (not when selftest imports resolveOutcome).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`contextreport failed: ${(e as Error).stack ?? e}`); process.exit(1); });
}
