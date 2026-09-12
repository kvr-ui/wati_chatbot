# Production database guide

The bot stores conversations in **SQLite** (`node:sqlite`, built into Node 22+).
There is no database server to run, and at this scale there does not need to be:
a busy WhatsApp account writes a few thousand rows a day, which SQLite handles
without noticing.

This guide covers what to do before relying on it in production.

## What the data is

| File | Contains | Replaceable? |
|---|---|---|
| `data/conversations.sqlite` | Every customer question and bot answer, lead scores | **No** — this is the irreplaceable one |
| `data/feedback.sqlite` | Internal tester reviews | Mostly |
| `data/embeddings.json` | Knowledge-base vectors | Yes — `npm run ingest` rebuilds it |

`conversations.sqlite` contains **customer personal data**: phone numbers, names
and the full text of what people said. It is gitignored and must stay that way.
Do not copy it to a public server, a shared drive, or a third-party service.

## 1. Pin the Node version

`node:sqlite` is still marked experimental — that is the `ExperimentalWarning`
in the logs. It is stable in practice on Node 22, but the API may change in a
future major release.

```bash
node -v          # expect v22.x
```

Pin Node 22 on the server and do not let it auto-upgrade to a new major without
running `npm test` first.

## 2. WAL is enabled automatically

`src/db.js` opens every database in WAL mode with a 5-second busy timeout, so
the leads dashboard can read while the webhook writes. Nothing to configure.

One consequence: a database is now **three** files — `.sqlite`, `.sqlite-wal`
and `.sqlite-shm`. Never copy just the `.sqlite` file (see below).

## 3. Back up nightly

**Never `cp` a live SQLite file.** A plain copy can capture a half-written
transaction and misses the `-wal` file, giving you a backup that fails only when
you actually need it. Use the script, which uses `VACUUM INTO`:

```bash
npm run backup                      # snapshot into backups/, keep 7 days
BACKUP_KEEP_DAYS=30 npm run backup  # keep longer
BACKUP_DIR=/mnt/backups npm run backup
```

Schedule it with cron — `crontab -e`:

```cron
# Nightly database snapshot at 2:15am
15 2 * * * cd /home/sandy/Downloads/Focas/wati_chat-bot && /usr/bin/npm run backup >> /var/log/focas-backup.log 2>&1
```

### Verify a backup occasionally

A backup you have never restored is a guess. Every month or so:

```bash
node -e "import('./src/db.js').then(({openDatabase})=>{
  const d = openDatabase('backups/conversations-YYYY-MM-DDTHH-MM-SS.sqlite');
  console.log(d.prepare('PRAGMA integrity_check').get());
  console.log(d.prepare('SELECT COUNT(*) c FROM messages').get());
})"
```

Expect `integrity_check: ok` and a row count close to production.

### Restoring

Stop the bot first, or you will be writing to a file you are replacing:

```bash
sudo systemctl stop focas-bot
cp backups/conversations-<stamp>.sqlite data/conversations.sqlite
rm -f data/conversations.sqlite-wal data/conversations.sqlite-shm
sudo systemctl start focas-bot
```

> Snapshots live on the same machine, so they protect against corruption, a bad
> deploy and mistakes — **not** against the disk or server dying. Once real
> customer history accumulates, copy `backups/` off the box as well.

## 4. Keep the bot running

Backups run from cron, but the bot itself needs to survive crashes and reboots.
`/etc/systemd/system/focas-bot.service`:

```ini
[Unit]
Description=FOCAS WhatsApp bot
After=network.target

[Service]
Type=simple
User=sandy
WorkingDirectory=/home/sandy/Downloads/Focas/wati_chat-bot
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now focas-bot
sudo systemctl status focas-bot
journalctl -u focas-bot -f        # live logs
```

## 5. Replace the ngrok tunnel

ngrok hands out a new URL on every restart, and the WATI webhook has to be
re-pasted each time. For production, point a domain at the server and put
nginx or Caddy in front with a real TLS certificate, then set the WATI webhook
to that fixed URL once.

Keep `WEBHOOK_VERIFY_TOKEN` set — it is what stops anyone who finds the URL from
injecting fake messages.

## When to outgrow SQLite

Move to Postgres (Neon, Supabase, RDS) only when one of these becomes true:

- **You deploy to serverless** (Vercel, Lambda). The filesystem is ephemeral —
  conversation history would be wiped on every deploy. This is the one that
  actually forces a migration.
- **You run more than one instance.** SQLite assumes a single machine, and
  `src/sessions.js` keeps conversation memory in process memory anyway, so a
  second instance breaks more than the database.
- **The sales team needs to query it directly** alongside other business systems.

The migration is contained: `src/conversations.js` is the only file that touches
the conversation database, and the SQL is plain. Nothing else in the codebase
would need to change.
