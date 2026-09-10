import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { config, configSummary } from "./config.js";
import { getXray } from "./orderflowxray.js";
import { state } from "./dashboardState.js";
import { journalSummary } from "./journal.js";
import { nativeNotify } from "./notify.js";
import { paperApi, paperClose, paperPnl } from "./paper.js";
import { liveApi } from "./live.js";
import { addManualTrade, closeManualTrade, deleteManualTrade, manualApi } from "./manualtrades.js";
import { ICON_SVG, MANIFEST, SW_JS } from "./pwa.js";
import { getSweepLog } from "./liquiditysweeps.js";
import { getReclaimLog } from "./reversal.js";
import { getSpoofLog } from "./spoof.js";

/**
 * Tiny HTTP server (no deps) that serves the live dashboard and JSON endpoints
 * the page polls. Runs inside the bot process so it shares live state.
 */
function mimeFor(p: string): string {
  if (p.endsWith(".html")) return "text/html; charset=utf-8";
  if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (p.endsWith(".css")) return "text/css; charset=utf-8";
  if (p.endsWith(".json") || p.endsWith(".map")) return "application/json";
  if (p.endsWith(".ico")) return "image/x-icon";
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".svg")) return "image/svg+xml";
  if (p.endsWith(".woff2")) return "font/woff2";
  if (p.endsWith(".ttf")) return "font/ttf";
  return "application/octet-stream";
}

// Expo emits hash-named assets (…-<hash>.js) that can cache forever, but index.html must always revalidate —
// otherwise a browser keeps serving a stale shell after a redeploy and never picks up the new bundle. Header
// only (set before the body is written) — zero latency/CPU cost, same footprint as the CORS headers.
function cacheFor(p: string): string {
  return p.endsWith(".html") ? "no-cache" : "public, max-age=31536000, immutable";
}

// The Expo web bundle is a multi-MB JS file — the dominant first-load cost. Gzip it (text assets
// compress ~70-80%) so the browser pulls far fewer bytes. Assets are content-hashed + immutable, so
// their gzipped bytes never change: compress once, cache in memory, and every later request is a
// zero-CPU buffer send. index.html is skipped (must revalidate) and non-text assets don't benefit.
const GZIP_STATIC = /\.(js|mjs|css|json|map|svg|ttf)$/;
const gzCache = new Map<string, Buffer>();
function gzipStatic(fullPath: string, data: Buffer): Buffer {
  const hit = gzCache.get(fullPath);
  if (hit) return hit;
  const gz = gzipSync(data);
  gzCache.set(fullPath, gz);
  return gz;
}

// Send JSON with gzip when the client accepts it — big win over LAN/mobile (JSON
// compresses ~75%). Small bodies are sent raw (gzip framing isn't worth it).
function sendJson(req: IncomingMessage, res: ServerResponse, obj: unknown): void {
  const body = JSON.stringify(obj);
  const accepts = String(req.headers["accept-encoding"] ?? "").includes("gzip");
  if (accepts && body.length > 860) {
    const gz = gzipSync(body);
    res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
    res.end(gz);
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
  }
}

export function startServer(): Server {
  const server = createServer(async (req, res) => {
    // CORS: let the Expo app (web + native) consume the API. Response-header only — no logic/latency impact.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    const url = (req.url ?? "/").split("?")[0] ?? "/";
    // Serve the built Expo / React-Native web app (single-page) at /app — the new RN UI, runs without Metro.
    if (url === "/app" || url.startsWith("/app/")) {
      const distRoot = join(process.cwd(), "app", "dist");
      let sub = url === "/app" || url === "/app/" ? "index.html" : url.slice(5);
      try { sub = decodeURIComponent(sub); } catch { res.writeHead(400); res.end("bad request"); return; }
      const full = resolve(distRoot, sub);
      const safeRoot = resolve(distRoot) + sep;
      if (!full.startsWith(safeRoot) && full !== resolve(distRoot)) { res.writeHead(403); res.end("forbidden"); return; }
      try {
        const data = await readFile(full);
        const accepts = String(req.headers["accept-encoding"] ?? "").includes("gzip");
        if (accepts && GZIP_STATIC.test(full) && data.length > 860) {
          res.writeHead(200, { "Content-Type": mimeFor(full), "Cache-Control": cacheFor(full), "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
          res.end(gzipStatic(full, data));
        } else {
          res.writeHead(200, { "Content-Type": mimeFor(full), "Cache-Control": cacheFor(full) });
          res.end(data);
        }
      } catch {
        try { const html = await readFile(join(distRoot, "index.html")); res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }); res.end(html); } catch { res.writeHead(404); res.end("app not built — run: cd app && npx expo export -p web"); }
      }
      return;
    }
    if (req.method === "POST" && url === "/api/paper/close") {
      const body = await new Promise<string>((resolve) => {
        let b = "";
        req.on("data", (d) => (b += d));
        req.on("end", () => resolve(b));
      });
      try {
        const { id, account, fraction } = JSON.parse(body || "{}");
        const trade = await paperClose(String(id), account ? String(account) : undefined, fraction != null ? Number(fraction) : 1);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(trade ?? { ok: false }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"ok":false}');
      }
      return;
    }
    if (req.method === "POST" && (url === "/api/manual" || url === "/api/manual/close" || url === "/api/manual/delete")) {
      const body = await new Promise<string>((resolve) => {
        let b = "";
        req.on("data", (d) => (b += d));
        req.on("end", () => resolve(b));
      });
      try {
        const d = JSON.parse(body || "{}");
        let out: unknown;
        if (url === "/api/manual") {
          const entry = Number(d.entry);
          const size = Number(d.size);
          const stop = d.stop != null && d.stop !== "" ? Number(d.stop) : undefined;
          const target = d.target != null && d.target !== "" ? Number(d.target) : undefined;
          if (Number.isNaN(entry) || entry <= 0 || Number.isNaN(size) || size <= 0) throw new Error("invalid entry/size");
          if (stop !== undefined && (Number.isNaN(stop) || stop <= 0)) throw new Error("invalid stop");
          if (target !== undefined && (Number.isNaN(target) || target <= 0)) throw new Error("invalid target");
          out = await addManualTrade({
            symbol: String(d.symbol || "").toUpperCase().trim(),
            direction: d.direction === "SHORT" ? "SHORT" : "LONG",
            entry,
            size,
            stop,
            target,
            note: d.note ? String(d.note).slice(0, 200) : undefined,
          });
        } else if (url === "/api/manual/close") {
          out = await closeManualTrade(String(d.id), d.exit != null && d.exit !== "" ? Number(d.exit) : undefined);
        } else {
          out = { ok: await deleteManualTrade(String(d.id)) };
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out ?? { ok: false }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"ok":false}');
      }
      return;
    }
    if (url === "/" || url === "/index.html") {
      // The React-Native app is now the primary UI — bounce the root to it. The old HTML dashboard still
      // lives at /classic (302 not 301 so it stays easily reversible and isn't hard-cached by browsers).
      res.writeHead(302, { Location: "/app" });
      res.end();
    } else if (url === "/classic") {
      // Retired: the old teal HTML dashboard diverged from the current app design.
      // Bounce any lingering bookmark to the live app (302, easily reversible).
      res.writeHead(302, { Location: "/app" });
      res.end();
    } else if (url === "/health" || url === "/api/health") {
      const mem = process.memoryUsage();
      sendJson(req, res, {
        status: "ok",
        uptimeSec: Math.floor(process.uptime()),
        pid: process.pid,
        memory: {
          heapUsedMb: Number((mem.heapUsed / 1024 / 1024).toFixed(2)),
          rssMb: Number((mem.rss / 1024 / 1024).toFixed(2)),
        },
        watchlist: config.watchlist,
        timestamp: new Date().toISOString(),
      });
    } else if (url === "/api/dash") {
      // ONE bundled request for the fast-changing dashboard set — collapses ~9 polls into 1,
      // cutting per-request overhead ~90% (matters most on LAN/mobile). Slow data (backtest,
      // config) stays on its own low-frequency poll so it isn't re-sent every 2s.
      sendJson(req, res, {
        state,
        paper: paperApi(),
        journal: journalSummary(),
        pnl: paperPnl(),
        manual: await manualApi(),
        live: liveApi(),
        sweeps: getSweepLog(),
        spoof: getSpoofLog(),
        reversals: getReclaimLog(),
      });
    } else if (url === "/api/state") {
      sendJson(req, res, state);
    } else if (url === "/manifest.webmanifest") {
      res.writeHead(200, { "Content-Type": "application/manifest+json" });
      res.end(MANIFEST);
    } else if (url === "/sw.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end(SW_JS);
    } else if (url === "/icon.svg") {
      res.writeHead(200, { "Content-Type": "image/svg+xml" });
      res.end(ICON_SVG);
    } else if (url === "/api/test-notify") {
      nativeNotify("Candela", "Test alert — desktop notifications are working ✅");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    } else if (url === "/api/xray") {
      // ORDERFLOW X-RAY — footprint/delta/CVD/DOM/absorption for one symbol. CONTEXT panel, not a signal source.
      const q = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
      const sym = (q.get("symbol") || config.watchlist[0] || "BTCUSDT").toUpperCase();
      void getXray(sym)
        .then((snap) => sendJson(req, res, snap ?? { error: "no data" }))
        .catch(() => sendJson(req, res, { error: "fetch failed" }));
    } else if (url === "/api/spoof") {
      sendJson(req, res, getSpoofLog());
    } else if (url === "/api/sweeps") {
      sendJson(req, res, getSweepLog());
    } else if (url === "/api/reversals") {
      sendJson(req, res, getReclaimLog());
    } else if (url === "/api/journal") {
      sendJson(req, res, journalSummary());
    } else if (url === "/api/paper") {
      sendJson(req, res, paperApi());
    } else if (url === "/api/pnl") {
      sendJson(req, res, paperPnl());
    } else if (url === "/api/live") {
      sendJson(req, res, liveApi());
    } else if (url === "/api/manual") {
      sendJson(req, res, await manualApi());
    } else if (url === "/api/config") {
      sendJson(req, res, configSummary());
    } else if (url === "/api/backtest") {
      // Static-ish JSON file (~12KB) → gzip it directly (biggest single payload; compresses ~75%).
      // Served from the raw file bytes so we don't parse+re-stringify a large blob every poll.
      try {
        const data = await readFile(config.backtest.outFile, "utf8");
        const accepts = String(req.headers["accept-encoding"] ?? "").includes("gzip");
        if (accepts && data.length > 860) {
          res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
          res.end(gzipSync(data));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(data);
        }
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      }
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  server.listen(config.dashboard.port, () => {
    console.log(`dashboard: http://localhost:${config.dashboard.port}\n`);
  });
  server.on("error", (e) => console.error(`dashboard server error: ${(e as Error).message}`));
  return server;
}
