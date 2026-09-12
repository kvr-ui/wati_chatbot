# Production database guide

Conversations and lead scores live in **MongoDB**, matching the other FOCAS
projects. Tester feedback stays in a small local SQLite file.

| Store | Contains | Replaceable? |
|---|---|---|
| `focas.wati_messages` | Every customer question and bot answer | **No** — the irreplaceable one |
| `focas.wati_leads` | Lead scores, stages, signals | Yes — derived, rebuild with rescore |
| `data/feedback.sqlite` | Internal tester reviews | Mostly |
| `data/embeddings.json` | Knowledge-base vectors | Yes — `npm run ingest` rebuilds it |

`wati_messages` holds **customer personal data**: phone numbers, names and the
full text of what people said. Never expose the database to the internet, and
keep backups off public storage.

## Configuration

```bash
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB_NAME=focas
MONGODB_MESSAGES_COLLECTION=wati_messages
MONGODB_LEADS_COLLECTION=wati_leads
```

Collections are domain-prefixed so they sit alongside `vsl_leads` and
`bigin_contacts` in the same database without colliding.

Indexes are created automatically on first connect (`src/mongo.js`) and
`createIndex` is idempotent, so every boot is safe.

## Design rule: scores are derived

`wati_messages` is the source of truth and stores every turn verbatim.
`wati_leads` is a **cache** — `POST /api/leads/rescore` rebuilds every score
from the stored messages.

So scoring rules in `SIGNALS` can be retuned freely; never hand-edit stored
scores, and never delete from `wati_messages`.

## If MongoDB goes down

The bot **keeps answering customers**. Logging failures are swallowed
(`logTurn` catches), so a database outage costs you log lines, not sales.
The leads dashboard returns 503 and `/health` reports the connection error.

That is deliberate: the reply matters more than the record of it.

## Backups

```bash
npm run backup                       # dump to backups/, keep 7 days
BACKUP_KEEP_DAYS=30 npm run backup
BACKUP_DIR=/mnt/backups npm run backup
```

Produces one gzipped `mongodump` archive per collection, plus a SQLite
snapshot of feedback taken with `VACUUM INTO` (copying a live SQLite file can
capture a half-written transaction and misses the `-wal` file).

Schedule with cron — `crontab -e`:

```cron
# Nightly database snapshot at 2:15am
15 2 * * * cd /home/sandy/Downloads/Focas/wati_chat-bot && /usr/bin/npm run backup >> /var/log/focas-backup.log 2>&1
```

Requires `mongodump` from **mongodb-database-tools**.

### Verify a backup — actually do this

A backup you have never restored is a guess. This check caught a real bug
where the archive silently contained no messages at all:

```bash
mongorestore --uri=mongodb://127.0.0.1:27017 \
  --archive=backups/wati_messages-<stamp>.archive.gz --gzip \
  --nsFrom='focas.*' --nsTo='restore_verify.*' --drop

mongosh --quiet restore_verify --eval "
  print(db.wati_messages.countDocuments());
  print(db.wati_messages.findOne({role:'user'}).text);
  db.dropDatabase();"
```

Expect a row count close to production and readable message text. Restoring
into `restore_verify` means production is never touched.

> Note: `mongodump` honours only the **last** `--collection` flag if you pass
> several — which is why the script dumps one archive per collection.

### Restoring for real

```bash
sudo systemctl stop focas-bot
mongorestore --uri="$MONGODB_URI" --archive=backups/wati_messages-<stamp>.archive.gz --gzip --drop
mongorestore --uri="$MONGODB_URI" --archive=backups/wati_leads-<stamp>.archive.gz --gzip --drop
sudo systemctl start focas-bot
```

> Snapshots live on the same machine, so they protect against corruption, a bad
> deploy and mistakes — **not** against the disk or server dying. Once real
> customer history accumulates, copy `backups/` off the box (`rsync` in the same
> cron job), or move to Atlas and let it handle backups.

## Storage

Measured at **~1.4 KB per exchange** (question + answer + metadata):

| Volume | Per year |
|---|---|
| 100 exchanges/day | 50 MB |
| 500 exchanges/day | 248 MB |
| 2,000 exchanges/day | ~1 GB |

Backups multiply this by the number of retained snapshots. Neither is a
concern on a normal VPS.

## Keep the bot running

`/etc/systemd/system/focas-bot.service`:

```ini
[Unit]
Description=FOCAS WhatsApp bot
After=network.target mongod.service
Wants=mongod.service

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
journalctl -u focas-bot -f        # live logs
```

## Replace the ngrok tunnel

ngrok hands out a new URL on every restart, and the WATI webhook has to be
re-pasted each time. For production, point a domain at the server with nginx or
Caddy and a real TLS certificate, then set the WATI webhook once.

Keep `WEBHOOK_VERIFY_TOKEN` set — it is what stops anyone who finds the URL
from injecting fake messages.

## Migrating from the old SQLite store

Conversations recorded before the Mongo switch:

```bash
npm run migrate:mongo
```

Safe to re-run — messages are matched on `(waId, createdAt, role, text)`, so a
second run imports nothing rather than duplicating history.
