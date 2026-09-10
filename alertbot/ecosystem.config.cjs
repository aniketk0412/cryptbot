// pm2 process definition for the futures alert bot.
// This is CommonJS (.cjs) on purpose — the project itself is ESM, but pm2 reads
// its config as CommonJS.
//
// Usage on the server:
//   pm2 start ecosystem.config.cjs
//   pm2 save            # remember this process across reboots
//   pm2 startup systemd # then run the sudo line it prints
//
// It launches exactly the known-good command:  node --import tsx src/index.ts
// (same as `npm start`, but as a single supervised process pm2 can restart).
module.exports = {
  apps: [
    {
      name: "alertbot",
      script: "src/index.ts",
      interpreter: "node",
      interpreter_args: "--import tsx",
      cwd: __dirname,
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 30,
      restart_delay: 5000,
      // Config comes from .env (auto-loaded by src/env.ts) — put TELEGRAM_* and any
      // overrides (PORT, WATCHLIST, SYMBOL, INTERVAL, RESISTANCE/SUPPORT) there.
      // Anything set here would override .env; leaving it empty keeps one source of truth.
      env: {},
      out_file: "run.log",
      error_file: "run.err.log",
      time: false, // the bot already timestamps its own log lines
    },
  ],
};
