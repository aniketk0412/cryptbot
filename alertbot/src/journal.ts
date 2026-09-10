import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import type { Candle } from "./types.js";

/** One journaled trade signal and its (auto-evaluated) outcome. */
export interface JournalEntry {
  id: string; // symbol + signal candle closeTime (dedup key)
  time: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  level: string;
  entry: number;
  stop: number;
  target: number;
  rr: number;
  score?: string;
  signalCloseTime: number;
  status: "open" | "win" | "loss";
  resolvedAt?: string;
  exit?: number; // the price it resolved at (= target on a win, stop on a loss)
  maxR?: number; // furthest it ran IN FAVOR (in R) before resolving — the "why it failed" signal
}

let entries: JournalEntry[] = [];
let loaded = false;

function adopt(raw: string): boolean {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return false;
  entries = parsed;
  return true;
}

async function load(): Promise<void> {
  if (loaded) return;
  try {
    if (!adopt(await readFile(config.journal.file, "utf8"))) throw new Error("bad shape");
  } catch {
    try {
      if (adopt(await readFile(`${config.journal.file}.bak`, "utf8"))) console.log("journal: recovered from backup (.bak)");
    } catch {
      // no journal yet
    }
  }
  loaded = true;
}

async function save(): Promise<void> {
  await mkdir(dirname(config.journal.file), { recursive: true });
  // Atomic write (temp + rename) so a mid-write crash can't corrupt the journal.
  const tmp = `${config.journal.file}.tmp`;
  await writeFile(tmp, JSON.stringify(entries, null, 2), "utf8");
  await rename(tmp, config.journal.file);
  await copyFile(config.journal.file, `${config.journal.file}.bak`).catch(() => {}); // best-effort recovery point
}

/** Record a new signal as an open trade (deduped by id). */
export async function logSignal(e: Omit<JournalEntry, "status">): Promise<void> {
  await load();
  if (entries.some((x) => x.id === e.id)) return;
  entries.unshift({ ...e, status: "open" });
  await save();
}

/**
 * Judge open trades for `symbol` against the latest candles: whichever of
 * stop/target the price reaches first (after the signal candle) resolves it.
 * Runs every cycle, so outcomes land in near-real-time.
 */
export async function evaluateOpen(symbol: string, candles: Candle[]): Promise<void> {
  await load();
  let changed = false;
  const closed = candles.filter((c) => c.closed);
  for (const e of entries) {
    if (e.symbol !== symbol || e.status !== "open") continue;
    const risk = Math.abs(e.entry - e.stop) || 1;
    let maxFav = e.maxR ?? 0; // carry across cycles; grows monotonically
    for (const c of closed) {
      if (c.closeTime <= e.signalCloseTime) continue;
      // how far this candle ran IN FAVOR (R) — the max-favourable-excursion so we can later explain WHY a loss lost
      const fav = e.direction === "LONG" ? (c.high - e.entry) / risk : (e.entry - c.low) / risk;
      if (fav > maxFav) maxFav = fav;
      if (e.direction === "LONG") {
        if (c.low <= e.stop) e.status = "loss";
        else if (c.high >= e.target) e.status = "win";
      } else {
        if (c.high >= e.stop) e.status = "loss";
        else if (c.low <= e.target) e.status = "win";
      }
      if (e.status !== "open") {
        e.resolvedAt = new Date().toISOString();
        e.exit = e.status === "win" ? e.target : e.stop;
        e.maxR = Math.max(0, maxFav);
        changed = true;
        break;
      }
    }
    if (e.status === "open" && maxFav > (e.maxR ?? 0)) { e.maxR = maxFav; changed = true; }
  }
  if (changed) await save();
}

interface SourceStat {
  wins: number;
  losses: number;
  open: number;
  total: number;
  winRate: number;
}

/** Live track-record summary for the dashboard, incl. per-source accuracy. */
export function journalSummary() {
  const wins = entries.filter((e) => e.status === "win").length;
  const losses = entries.filter((e) => e.status === "loss").length;
  const open = entries.filter((e) => e.status === "open").length;

  const bySource: Record<string, SourceStat> = {};
  for (const e of entries) {
    const key = e.level || "?";
    const g = bySource[key] ?? { wins: 0, losses: 0, open: 0, total: 0, winRate: 0 };
    g.total++;
    if (e.status === "win") g.wins++;
    else if (e.status === "loss") g.losses++;
    else g.open++;
    g.winRate = g.wins + g.losses > 0 ? g.wins / (g.wins + g.losses) : 0;
    bySource[key] = g;
  }

  return {
    stats: { total: entries.length, wins, losses, open, winRate: wins + losses > 0 ? wins / (wins + losses) : 0 },
    bySource,
    entries: entries.slice(0, config.journal.maxDashboard),
  };
}
