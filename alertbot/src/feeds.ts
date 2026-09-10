/**
 * Lightweight health tracker for the WebSocket data feeds. So the dashboard can
 * say honestly whether each feed is LIVE — instead of a dead/blocked feed silently
 * looking the same as a quiet market.
 */
interface FeedState {
  connected: boolean;
  everMsg: boolean;
  lastMsgAt: number;
}
const feeds = new Map<string, FeedState>();

function get(name: string): FeedState {
  let f = feeds.get(name);
  if (!f) {
    f = { connected: false, everMsg: false, lastMsgAt: 0 };
    feeds.set(name, f);
  }
  return f;
}

export function feedOpen(name: string): void { get(name).connected = true; }
export function feedClosed(name: string): void { get(name).connected = false; }
export function feedMsg(name: string): void {
  const f = get(name);
  f.everMsg = true;
  f.lastMsgAt = Date.now();
}

export interface FeedStatus { name: string; state: "live" | "idle" | "stale" | "off" }

/**
 * Per-feed health. `price` ticks ~1s so >15s silent = stale; `liquidations` are
 * sparse by nature, so "connected but no data yet" is reported as idle (not dead).
 */
export function feedStatuses(): FeedStatus[] {
  const now = Date.now();
  const out: FeedStatus[] = [];
  for (const [name, f] of feeds) {
    const staleMs = name === "price" ? 15_000 : 600_000;
    let state: FeedStatus["state"];
    if (!f.connected) state = "off";
    else if (!f.everMsg) state = "idle";
    else if (now - f.lastMsgAt > staleMs) state = "stale";
    else state = "live";
    out.push({ name, state });
  }
  return out;
}
