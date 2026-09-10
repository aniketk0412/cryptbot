import { fapiJson } from "./binance.js";
import { config } from "./config.js";

interface Depth {
  bids: [string, string][];
  asks: [string, string][];
}
interface Wall {
  price: number;
  size: number;
  side: "bid" | "ask";
}
interface SpoofState {
  lastWalls: Wall[];
  pulls: number; // cumulative pulled-wall count
}
const states = new Map<string, SpoofState>();
function st(sym: string): SpoofState {
  let s = states.get(sym);
  if (!s) {
    s = { lastWalls: [], pulls: 0 };
    states.set(sym, s);
  }
  return s;
}

export interface SpoofResult {
  suspected: boolean;
  note: string;
  pulls: number;
}

export interface SpoofEvent {
  time: number;
  symbol: string;
  note: string;
}
const spoofLog: SpoofEvent[] = [];
export function getSpoofLog(): SpoofEvent[] {
  return spoofLog.slice(0, 40);
}

/**
 * Detect pulled walls (spoofing) by comparing this cycle's order book to last:
 * a large wall near price that has since vanished/shrunk — while price never
 * traded through it — was cancelled, i.e. it was probably a spoof.
 *
 * Heuristic (REST snapshots, not L3), so it flags suspicion, not proof.
 */
export async function checkSpoof(symbol: string, price: number): Promise<SpoofResult> {
  const s = st(symbol);
  const depth = await fapiJson<Depth>(`/fapi/v1/depth?symbol=${symbol}&limit=50`);
  if (!depth?.bids || !depth?.asks) return { suspected: false, note: "", pulls: s.pulls };

  const band = price * (config.spoof.bandPct / 100);
  const near: Wall[] = [
    ...depth.bids.filter((b) => +b[0] >= price - band).map((b) => ({ price: +b[0], size: +b[1], side: "bid" as const })),
    ...depth.asks.filter((a) => +a[0] <= price + band).map((a) => ({ price: +a[0], size: +a[1], side: "ask" as const })),
  ];
  if (near.length === 0) {
    s.lastWalls = [];
    return { suspected: false, note: "", pulls: s.pulls };
  }

  const sorted = near.map((w) => w.size).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const walls = near.filter((w) => w.size >= median * config.spoof.wallMult);

  // Compare last cycle's walls: pulled = gone/shrunk AND price hasn't crossed it.
  let pulledNow = 0;
  let note = "";
  for (const pw of s.lastWalls) {
    const survived = walls.find(
      (w) => Math.abs(w.price - pw.price) / pw.price < 0.0005 && w.size >= pw.size * config.spoof.keepFrac,
    );
    const priceCrossed = pw.side === "bid" ? price < pw.price : price > pw.price;
    if (!survived && !priceCrossed) {
      pulledNow++;
      note = `${pw.side} wall ~${Math.round(pw.size)} @ ${pw.price} pulled`;
    }
  }

  s.lastWalls = walls;
  if (pulledNow > 0) {
    s.pulls += pulledNow;
    if (note) {
      spoofLog.unshift({ time: Date.now(), symbol, note });
      if (spoofLog.length > 100) spoofLog.length = 100;
    }
  }
  return { suspected: pulledNow > 0, note, pulls: s.pulls };
}
