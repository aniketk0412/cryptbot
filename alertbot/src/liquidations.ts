import { config } from "./config.js";
import { feedClosed, feedMsg, feedOpen } from "./feeds.js";

interface Liq {
  time: number;
  side: "long" | "short"; // which side got liquidated
  usd: number;
}
const recent = new Map<string, Liq[]>();

/** Open a force-order WebSocket per symbol; auto-reconnect on close. */
export function startLiquidationFeed(symbols: string[]): void {
  if (!config.liquidation.enabled) return;
  for (const sym of symbols) connect(sym);
}

function connect(sym: string): void {
  const url = `wss://fstream.binance.com/ws/${sym.toLowerCase()}@forceOrder`;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    setTimeout(() => connect(sym), 5000);
    return;
  }
  ws.onmessage = (event: MessageEvent) => {
    try {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      const o = JSON.parse(raw).o;
      if (!o) return;
      feedMsg("liquidations");
      // Binance force-order: a SELL order means a LONG was liquidated (and vice versa).
      const side: Liq["side"] = o.S === "SELL" ? "long" : "short";
      const usd = Number(o.q) * Number(o.ap ?? o.p);
      const list = recent.get(sym) ?? [];
      list.unshift({ time: Date.now(), side, usd });
      recent.set(
        sym,
        list.filter((l) => Date.now() - l.time < config.liquidation.windowMs).slice(0, 200),
      );
    } catch {
      // ignore malformed frames
    }
  };
  ws.onopen = () => feedOpen("liquidations");
  ws.onclose = () => {
    feedClosed("liquidations");
    setTimeout(() => connect(sym), 5000);
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      /* noop */
    }
  };
}

export interface LiqSummary {
  count: number;
  longUsd: number;
  shortUsd: number;
  cascade: boolean;
  note: string;
}

/** Rolling-window liquidation totals + cascade flag for a symbol. */
export function liqSummary(sym: string): LiqSummary {
  const list = (recent.get(sym) ?? []).filter((l) => Date.now() - l.time < config.liquidation.windowMs);
  const longUsd = list.filter((l) => l.side === "long").reduce((s, l) => s + l.usd, 0);
  const shortUsd = list.filter((l) => l.side === "short").reduce((s, l) => s + l.usd, 0);
  const total = longUsd + shortUsd;
  const cascade = total > config.liquidation.cascadeUsd;
  const dom = longUsd >= shortUsd ? "longs" : "shorts";
  const note = cascade ? `⚡ ${(total / 1e6).toFixed(2)}M liquidated (${dom}) — exhaustion?` : "";
  return { count: list.length, longUsd, shortUsd, cascade, note };
}
