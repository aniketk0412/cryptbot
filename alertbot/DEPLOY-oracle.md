# Deploy the alert bot on an Oracle Cloud "Always Free" VM

A step-by-step runbook to run this bot 24/7 on a free Oracle Cloud VM, exactly as it
runs on your PC (`node --import tsx src/index.ts`, JSON files for the paper record — no
database needed). Copy-paste the commands; `<PUBLIC_IP>` = your VM's IP.

---

## 0. Read this first — the 5 things that actually trip people up

1. **Pick a Binance-allowed region, and it's permanent.** Always-Free resources are locked
   to the region you choose at signup. Binance returns HTTP 451 (blocked) on US IPs — if the
   VM is in a US region, the bot fetches **nothing** and silently does nothing. Choose a region
   near you where Binance works (e.g. **Mumbai / Hyderabad** for India). This is the #1 killer.
2. **The free ARM shape is often "Out of host capacity."** The Ampere A1 (ARM) free tier is in
   heavy demand. If you can't get one: retry, try another Availability Domain, or just use the
   AMD **VM.Standard.E2.1.Micro** (1 CPU / 1 GB) — it's almost always available and is plenty
   for this bot (3 symbols, a 20s loop).
3. **Signup needs a card** for identity verification (you are **not** charged for Always-Free).
4. **The dashboard has no login.** Do **not** open port 1000 to the internet. We view it over an
   SSH tunnel (Step 8). Leaving it public would broadcast your positions and strategy.
5. **Run ONE instance only.** Once the VM bot is live, stop the one on your PC — two instances
   = two diverging paper accounts and double Telegram alerts.

> On a headless server there's no terminal to watch, so **set up Telegram** (Step 6) — that's how
> you'll actually receive alerts. Without it, alerts only go to `pm2 logs`.

---

## 1. Create the VM
Oracle Cloud console → **Compute → Instances → Create instance**:
- **Image:** Ubuntu 22.04 (or 24.04).
- **Shape:** *Ampere A1 Flex*, set **1 OCPU / 6 GB** (well within free) — or if capacity-blocked,
  switch to **VM.Standard.E2.1.Micro** (AMD, 1 CPU / 1 GB).
- **SSH keys:** upload your public key. (No key yet? On Windows in git-bash:
  `ssh-keygen -t ed25519` → your public key is `~/.ssh/id_ed25519.pub`.)
- **Networking:** default VCN is fine. Leave only **SSH (22)** open — do **not** add an ingress
  rule for port 1000.
- Create, then copy the **Public IP address**.

## 2. Connect
```bash
ssh ubuntu@<PUBLIC_IP>
```

## 3. Install Node 22 + pm2
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2
node -v          # expect v22.x  (need ≥20.6 for .env auto-load + stable WebSocket)
```

## 4. (1 GB micro only) add swap — so on-the-fly TS compile can't run you out of RAM
```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```
(Skip on the 6 GB ARM.)

## 5. Copy the code up — run this on YOUR PC (git-bash), from `X:\cryptbot`
```bash
rsync -avz --exclude node_modules --exclude '*.log' alertbot/ ubuntu@<PUBLIC_IP>:~/alertbot/
```
- This includes your `data/` folder, so the paper record carries over. Want a **fresh** $1000
  start instead? add `--exclude data`.
- **No rsync?** `scp -r alertbot ubuntu@<PUBLIC_IP>:~/alertbot` then on the VM:
  `rm -rf ~/alertbot/node_modules` (Windows binaries won't run on Linux).

## 6. Install deps + secrets — back on the VM
```bash
cd ~/alertbot
npm install               # installs tsx/typescript (they're devDependencies but REQUIRED to run)
# Optional but recommended on a server — phone alerts:
nano .env                 # add:  TELEGRAM_BOT_TOKEN=...   and   TELEGRAM_CHAT_ID=...
```
- Don't set `NODE_ENV=production` — it would skip `tsx` and the bot won't start.
- Need the chat id? with the token set in `.env`, message your bot "hi", then `npm run tg:chatid`.

## 7. Run it under pm2 (auto-restart + survives reboots)
```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd       # prints a `sudo env PATH=... pm2 startup` line — copy-paste & run it
pm2 logs alertbot         # watch it boot (Ctrl-C stops watching; the bot keeps running)
```
You should see the banner, then per-cycle `SOLUSDT px=… / paper — …` lines every ~20s.

## 8. View the dashboard securely — from your PC
```bash
ssh -L 1000:localhost:1000 ubuntu@<PUBLIC_IP>
```
Leave that terminal open, then browse **http://localhost:1000**. The tunnel forwards it to you
privately; nothing is exposed to the internet.

## 9. Stop the bot on your PC
So only one instance runs. (Just kill the local `node ... index.ts` process.)

---

## Updating later (when the code changes)
On your PC:
```bash
rsync -avz --exclude node_modules --exclude '*.log' alertbot/ ubuntu@<PUBLIC_IP>:~/alertbot/
```
On the VM:
```bash
cd ~/alertbot && npm install && pm2 restart alertbot
```

## Handy pm2
| Command | Does |
|---|---|
| `pm2 status` | is it running? |
| `pm2 logs alertbot` | live logs |
| `pm2 restart alertbot` | restart (after an update) |
| `pm2 stop alertbot` | pause it |
| `pm2 monit` | CPU/RAM dashboard |

## Later, if you want phone access without a tunnel
That needs a login + HTTPS in front of the dashboard (e.g. a Caddy reverse proxy with basic auth
and a free domain). Ask and I'll add it — don't just open port 1000, it has no auth.
