// Real-time price feed via Binance combined miniTicker WebSocket, so the dashboard price updates every ~second.
//
// 2026-07-15 — now prefers the FUTURES stream (fstream.binance.com) since the bot trades USDⓈ-M futures, with a
// SELF-HEALING fallback: if futures delivers no frames (the known "zero-frame silent drop" on some networks — a
// routing block, not a keepalive miss), we fall back to the SPOT stream, which flows here (spot px ≈ futures px).
// A staleness watchdog force-reconnects if frames stop arriving. (Note: the WHATWG `WebSocket` in Node does not
// expose a client `.ping()` and Binance market streams ignore JSON `{"method":"PING"}` — the server sends WS pings
// that are auto-ponged, so the watchdog, not an app-level ping, is what actually defends against a silent drop.)

import { feedClosed, feedMsg, feedOpen } from "./feeds.js";

const prices = new Map<string, number>();

const FUTURES = "wss://fstream.binance.com/stream?streams=";
const SPOT = "wss://stream.binance.com:9443/stream?streams=";
const STARTUP_SILENCE_MS = 8_000; // if a fresh connection delivers no frame within this, treat it as blocked
const STALE_MS = 90_000; // no frame for this long on a live connection → force reconnect
const WATCHDOG_MS = 30_000; // how often the watchdog checks liveness
const PREFER_FUTURES = (process.env.LIVEPRICE_ENDPOINT ?? "futures") !== "spot";

let lastMsgAt = 0;
let futuresStrikes = 0; // consecutive futures attempts that stayed silent → after 2, stick to spot

export function startLivePriceFeed(symbols: string[]): void {
  if (symbols.length === 0) return;
  const streams = symbols.map((s) => s.toLowerCase() + "@miniTicker").join("/");
  // Endpoint choice self-heals: prefer futures, but once it has proven silent twice, use spot until restart.
  connect(streams, PREFER_FUTURES && futuresStrikes < 2 ? "futures" : "spot");
  startWatchdog(streams);
}

function connect(streams: string, mode: "futures" | "spot"): void {
  const url = (mode === "futures" ? FUTURES : SPOT) + streams;
  let ws: WebSocket;
  let gotFrame = false;
  try {
    ws = new WebSocket(url);
  } catch {
    setTimeout(() => connect(streams, mode), 5000);
    return;
  }

  // Startup silence check: if a just-opened connection delivers nothing, it's (likely) blocked — rotate endpoint.
  const startupTimer = setTimeout(() => {
    if (!gotFrame) {
      if (mode === "futures") futuresStrikes++;
      console.log(`live-price: ${mode} stream silent for ${STARTUP_SILENCE_MS / 1000}s — switching to ${mode === "futures" ? "spot" : "futures"}`);
      try { ws.close(); } catch { /* noop */ }
      connect(streams, mode === "futures" ? "spot" : "futures");
    }
  }, STARTUP_SILENCE_MS);

  ws.onmessage = (event: MessageEvent) => {
    try {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      const msg = JSON.parse(raw);
      const d = msg.data ?? msg;
      if (d?.s && d?.c) {
        prices.set(d.s, Number(d.c));
        lastMsgAt = Date.now();
        if (!gotFrame) { gotFrame = true; clearTimeout(startupTimer); if (mode === "futures") futuresStrikes = 0; }
        feedMsg("price");
      }
    } catch {
      // ignore malformed frames
    }
  };
  ws.onopen = () => feedOpen("price");
  ws.onclose = () => {
    clearTimeout(startupTimer);
    feedClosed("price");
    // Reconnect, preferring the endpoint that has been working (spot once futures has struck out twice).
    setTimeout(() => connect(streams, PREFER_FUTURES && futuresStrikes < 2 ? "futures" : "spot"), 5000);
  };
  ws.onerror = () => {
    try { ws.close(); } catch { /* noop */ }
  };
}

let watchdogStarted = false;
function startWatchdog(streams: string): void {
  if (watchdogStarted) return;
  watchdogStarted = true;
  // Force a reconnect if a live connection goes quiet — the real defense against a silent drop. The onclose handler
  // picks the healthy endpoint. We can't send a client ping on the WHATWG WebSocket, so we reconnect instead.
  setInterval(() => {
    if (lastMsgAt > 0 && Date.now() - lastMsgAt > STALE_MS) {
      console.log(`live-price: no frames for ${Math.round((Date.now() - lastMsgAt) / 1000)}s — reconnecting`);
      lastMsgAt = Date.now(); // debounce so we don't spam reconnects before the new socket warms up
      connect(streams, PREFER_FUTURES && futuresStrikes < 2 ? "futures" : "spot");
    }
  }, WATCHDOG_MS);
}

export function getLivePrice(sym: string): number | undefined {
  return prices.get(sym);
}
