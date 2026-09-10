import { config } from "./config.js";
import { atr } from "./indicators.js";
import { brokeDown, brokeUp } from "./signals.js";
import type { Candle, Range } from "./types.js";

/** A live breakout being watched for a failed-breakout reclaim. */
interface Memo {
  dir: "up" | "down";
  level: number; // the level that broke (resistance for up, support for down)
  oppo: number; // opposite side of the range = the reclaim target
  brokeClose: number;
  extreme: number; // furthest price reached during the breakout excursion (for the stop)
  bars: number; // closed candles since the breakout
}

export interface ReclaimSignal {
  symbol: string;
  direction: "LONG" | "SHORT";
  level: "support" | "resistance"; // the level that was reclaimed
  levelPrice: number;
  entry: number;
  stop: number;
  target: number;
  breakoutClose: number;
  barsAfter: number;
  time: number;
  reason: string;
}

const mem = new Map<string, Memo>();
const log: Array<{ time: number; symbol: string; direction: string; level: number; barsAfter: number }> = [];

/**
 * Failed-breakout / reclaim reversal — call once per NEW closed candle.
 *   Stage 1: a candle CLOSES out of the consolidation range → remember the breakout.
 *   Stage 2: within `reclaimWindow` candles, a candle CLOSES back INSIDE → the
 *            breakout failed (a bull/bear trap) → fade it back toward the far side.
 * Stop sits beyond the breakout's extreme; target is the opposite range level.
 */
export function checkFailedBreakout(symbol: string, lastClosed: Candle, closed: Candle[], range: Range): ReclaimSignal | null {
  if (!config.reversal.enabled) return null;
  const m = mem.get(symbol);

  if (m) {
    m.bars++;
    m.extreme = m.dir === "up" ? Math.max(m.extreme, lastClosed.high) : Math.min(m.extreme, lastClosed.low);
    if (m.bars > config.reversal.reclaimWindow) { mem.delete(symbol); return null; } // past the reclaim window → a real breakout, stop watching
    const reclaimed = m.dir === "up" ? lastClosed.close < m.level : lastClosed.close > m.level;
    if (reclaimed) {
      mem.delete(symbol);
      const a = atr(closed);
      const buf = Number.isFinite(a) && a > 0 ? a * 0.25 : lastClosed.close * 0.001;
      const direction: "LONG" | "SHORT" = m.dir === "up" ? "SHORT" : "LONG";
      const entry = lastClosed.close;
      const stop = m.dir === "up" ? m.extreme + buf : m.extreme - buf;
      const target = m.oppo;
      // Sanity: target on the profitable side, stop on the protective side.
      const valid = direction === "SHORT" ? target < entry && stop > entry : target > entry && stop < entry;
      if (!valid) return null;
      const sig: ReclaimSignal = {
        symbol,
        direction,
        level: m.dir === "up" ? "resistance" : "support",
        levelPrice: m.level,
        entry,
        stop,
        target,
        breakoutClose: m.brokeClose,
        barsAfter: m.bars,
        time: lastClosed.closeTime,
        reason:
          m.dir === "up"
            ? `broke resistance ${m.level.toFixed(2)} then closed back below — bull trap, fade the failed breakout`
            : `broke support ${m.level.toFixed(2)} then closed back above — bear trap, fade the failed breakdown`,
      };
      log.unshift({ time: sig.time, symbol, direction, level: m.level, barsAfter: m.bars });
      if (log.length > 50) log.length = 50;
      return sig;
    }
    return null;
  }

  // No active breakout — arm one when a candle closes out of a valid consolidation range.
  if (range.consolidating && range.high > range.low) {
    if (brokeUp(lastClosed, range)) {
      mem.set(symbol, { dir: "up", level: range.high, oppo: range.low, brokeClose: lastClosed.close, extreme: lastClosed.high, bars: 0 });
    } else if (brokeDown(lastClosed, range)) {
      mem.set(symbol, { dir: "down", level: range.low, oppo: range.high, brokeClose: lastClosed.close, extreme: lastClosed.low, bars: 0 });
    }
  }
  return null;
}

/** Recent failed-breakout reversals for the dashboard. */
export function getReclaimLog() {
  return log.slice(0, 20);
}
