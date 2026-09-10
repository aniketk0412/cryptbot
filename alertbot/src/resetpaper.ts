import "./env.js";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { config } from "./config.js";

/**
 * `npm run reset-paper` — start a CLEAN proof-of-profit: archive the current paper account + journal and
 * clear them so the next `npm start` begins fresh at the configured start balance.
 *
 * SAFE by design: it never destroys data — it copies paper.json + journal.json (and their .bak) into
 * data/archive/<name>.<timestamp>.bak first, then removes the live files. And it REFUSES to run if the bot
 * is currently up (which would just rewrite the files a second later) — stop the bot first.
 *
 * Use this only when you want a clean-slate track record (e.g. after a config change like enabling the
 * bear-only filter). To just keep trading, don't run it — the account persists across restarts by itself.
 */

const FILES = ["data/paper.json", "data/journal.json"];

async function main() {
  const port = process.env.PORT || 1000;
  // Guard: don't reset while the bot is running — it would rewrite the files on its next cycle.
  try {
    const res = await fetch(`http://localhost:${port}/api/paper`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      console.error(`⛔ The bot appears to be RUNNING on port ${port}. Stop it first (Ctrl+C in its terminal), then re-run this.\n   Aborting — no changes made.`);
      process.exit(1);
    }
  } catch {
    /* no response = bot not running = safe to proceed */
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  await mkdir("data/archive", { recursive: true });
  let archived = 0;
  for (const f of FILES) {
    for (const path of [f, `${f}.bak`]) {
      if (existsSync(path)) {
        const name = path.split("/").pop();
        await copyFile(path, `data/archive/${name}.${ts}`);
        await rm(path, { force: true });
        if (path === f) archived++;
        console.log(`  archived + cleared  ${path}  →  data/archive/${name}.${ts}`);
      }
    }
  }

  if (!archived) {
    console.log("\nNothing to reset — no paper.json / journal.json found (already fresh).");
    return;
  }
  console.log(`\n✅ Paper account + journal RESET (old track record archived, not deleted, in data/archive/).`);
  console.log(`   Next \`npm start\` begins fresh at $${config.paper.startBalanceUsd} — a clean proof of the current config.`);
}

main().catch((e) => {
  console.error(`reset-paper failed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
