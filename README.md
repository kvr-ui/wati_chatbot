# FOCASEdu chatbot playground (OpenAI + knowledge base)

A WhatsApp bot for [WATI](https://www.wati.io/). Incoming messages hit a webhook, get matched
against your keyword triggers, and are answered either with a fixed reply or with an AI
answer from **OpenAI** grounded in your own knowledge base.

```
WhatsApp -> WATI -> POST /webhook/wati -> keyword match ─┬─ static reply
                                                         ├─ AI answer (knowledge base + GPT)     
                                                         └─ handover to a human (bot goes quiet)
                                            reply sent back via WATI sendSessionMessage
```

## 1. Setup

```bash
npm install
cp .env.example .env      # then fill in the values
```

**WATI credentials** — WATI dashboard → *API Docs* (or *Settings → API*):

| .env key | Where to find it |
|---|---|
| `WATI_API_ENDPOINT` | The API endpoint shown there, e.g. `https://live-mt-server.wati.io/123456` |
| `WATI_ACCESS_TOKEN` | The Access Token / JWT — paste it **without** the leading `Bearer ` |

**OpenAI** — the only model provider. The bot answers with OpenAI chat models and searches the
knowledge base with OpenAI embeddings.

| .env key | Notes |
|---|---|
| `OPENAI_API_KEY` | Required. Used for every answer and for semantic knowledge-base search. |
| `OPENAI_CHAT_MODEL` | Default `gpt-4o-mini`. |
| `OPENAI_EMBEDDING_MODEL` | Default `text-embedding-3-small`. |
| `OPENAI_BASE_URL` | Optional OpenAI-compatible endpoint. Leave blank for api.openai.com. |

Verify with `npm run check:ai`.

### Knowledge-base search modes

Retrieval uses `KB_SEARCH_MODE=auto` by default: semantic search when embeddings work,
with keyword search over the same files if embeddings are unavailable. Set
`KB_SEARCH_MODE=lexical` to skip embeddings entirely.

- **Semantic (default)** → embeddings. Understands that "do you help with jobs" relates to a
  *Placement* section. Recommended.
- **`KB_SEARCH_MODE=lexical`** → keyword search over the same chunks. No embedding cost, but it
  only matches words that actually appear in your text. Keyword triggers with `kbFilter` cover
  the gap: a scoped trigger always returns its section regardless of word overlap.

## 2. Put your knowledge in

Everything the bot is allowed to say lives in [knowledge/](knowledge/).

- One `.md` file per topic — `30-fees-class-pricing.md`, `20-timings-and-slots.md`, and so on.
  Each file is one searchable chunk, so you edit one small file to change one answer.
  See [docs/knowledge-base-guide.md](docs/knowledge-base-guide.md) for the format and the rules.
- [knowledge/keywords.json](knowledge/keywords.json) — the keyword triggers.

Check your edits any time with:

```bash
npm run check:kb
```

Then build the search index:

```bash
npm run ingest
```

Re-run that (or `curl -X POST localhost:3000/reindex`) whenever you edit knowledge files.
`keywords.json` needs no re-index — it reloads on every message.

### Trigger format

```json
{
  "id": "fees",
  "match": "contains",
  "keywords": ["fee", "price", "how much"],
  "action": "ai",
  "kbFilter": "fee",
  "prompt": "Never guess a price."
}
```

| Field | Meaning |
|---|---|
| `match` | `exact` (whole message), `starts_with`, `contains` (whole word anywhere), `regex` |
| `action` | `reply` = send `reply` text · `ai` = answer from the knowledge base · `handover` = pause the bot for a human · `resume` = un-pause it · `optout` = never answer this contact again |
| `reply` | Text to send. Accepts `{{name}}` and `{{bot}}`. May be an array to send several messages. |
| `kbFilter` | Only search knowledge sections whose heading/filename contains this word |
| `prompt` | Extra instruction passed to the model for this topic |
| `priority` | Optional tie-breaker. Defaults: exact 100, starts_with 60, regex 40, contains 20 |

Plurals are tolerated automatically (`fee` matches `fees`). Matching is case- and
punctuation-insensitive. If nothing matches, the bot answers from the knowledge base anyway
(set `AI_FALLBACK_ENABLED=false` to send a fixed fallback message instead).

## 3. Test locally before touching WhatsApp

```bash
cd /home/sandy/Downloads/Focas/wati_chat-bot
npm run dev
```

Open **http://127.0.0.1:3000**. Ask a question or choose a sample prompt. The page
uses the same triggers, knowledge retrieval and conversation logic as the WATI handler.
Greetings and menu commands use saved replies; questions use OpenAI. Each AI answer shows
the retrieved knowledge files for review. These are retrieval context, not model citations.

- **New conversation** clears that browser conversation's server memory.
- **Knowledge base** lets you read the 28 existing knowledge files.
- Edit files in `knowledge/`, then use **Refresh knowledge** and start a new chat.
- Conversation memory lasts until inactivity expiry or server restart. Reloading the page
  starts a new browser conversation; the page does not persist chat transcripts.
- Errors appear in the composer with a retry button; failed requests do not enter memory.
- `WHATSAPP_ENABLED=false` disables the webhook and removes the need for WATI credentials.
  Preview sessions are isolated from WhatsApp contacts. Handover replies are simulations;
  they do not notify an agent or change WATI read status.
- `HOST=127.0.0.1` keeps this development playground local. Keep it local during testing;
  the testing endpoints have no login. Add access control before hosting it publicly.
- API keys stay in the server's `.env`; they are never sent to the browser.

Run the offline integration checks with `npm test`. They exercise the real API routes and
OpenAI request construction with a local mock provider, without contacting OpenAI or WATI.


```bash
npm run chat            # terminal chat with the same logic; type /why to see how a reply was chosen
npm run check:ai        # verify OpenAI answers
npm run check:ai -- "what are the fees"   # ask a specific question
npm run check:wati      # verify WATI credentials
```

Or run the server and poke it:

```bash
npm start
curl "localhost:3000/match?text=what%20are%20the%20fees"
curl -X POST localhost:3000/simulate -H 'content-type: application/json' -d '{"text":"hi"}'
```

## 4. Connect WATI later

After browser testing, configure WATI credentials and webhook authentication, protect or
remove the testing endpoints from the public deployment, set `WHATSAPP_ENABLED=true`,
and bind to the appropriate interface (`HOST=0.0.0.0` for a container). Restart the server.
Browser testing alone does not validate production delivery or human handover operations.


1. Expose the server publicly — `ngrok http 3000` while testing, or deploy it (any Node host).
2. WATI dashboard → **Settings → Webhooks → Add Webhook**.
3. URL: `https://your-domain.com/webhook/wati`
   (if you set `WEBHOOK_VERIFY_TOKEN`, append `?token=YOUR_TOKEN`).
4. Enable the **Message Received** event. Leave the others off — the bot ignores them anyway.
5. Message your WATI number from WhatsApp.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/webhook/wati` | WATI incoming-message webhook |
| GET | `/` | Browser chat playground |
| POST | `/api/chat` | `{ "sessionId": "unique-id", "text": "..." }` → test reply and retrieved sources |
| DELETE | `/api/chat/:sessionId` | Clear a browser conversation |
| GET | `/api/knowledge` | Knowledge file titles and contents |
| POST | `/simulate` | `{ "text": "..." }` → the reply, without sending anything to WhatsApp |
| GET | `/match?text=...` | Which trigger a phrase hits |
| POST | `/reindex` | Re-embed the knowledge base after editing files |
| GET | `/health` | Index size, trigger count, active sessions, allowlist, opt-in, opt-out and campaign-group counts |

## How it behaves

- **24-hour window.** Free-form replies only work within 24h of the customer's last message —
  that is a WhatsApp rule, not a bot limitation. To start a conversation, use an approved
  template via `sendTemplateMessage()` in [src/wati.js](src/wati.js).
- **Who the bot answers.** While `WHATSAPP_ALLOWED_NUMBERS` is set, the bot replies only to
  those numbers and ignores every other contact. Any other lead can unlock the bot *for its
  own number only* by sending the campaign phrase in `WHATSAPP_UNLOCK_PHRASE`
  (default `jan 2027, january 2027`, matched anywhere in the message, ignoring case and
  punctuation). That message is answered and the number is saved to the `wati_optins`
  collection, so the bot keeps talking to that one lead after a restart — and still to nobody
  else. Remove its document from `wati_optins` and restart to lock a number again; set
  `WHATSAPP_UNLOCK_PHRASE=` empty to disable opt-in entirely. With `WHATSAPP_ALLOWED_NUMBERS`
  blank the bot answers everyone and the phrase is irrelevant.
- **The January 2027 campaign script.** A lead arriving from the ad is asked one qualifying
  question before anything else: *"Which group are you planning to take the exam in January
  2027?"*, with the four options numbered (Group 1 / Group 2 / Both Groups / Unit 2D). Their
  first message is **not** answered otherwise — the question comes alone. The reply is matched
  loosely (`2`, `grp-2`, `group two`, `both`, `unit 2d` all work); the group is echoed back
  inside the offerings message and saved to the `wati_campaign` collection, so a restart or an
  expired session cannot lose it. An answer that names no group is re-asked once, and after
  that the lead is let through to normal answering rather than stonewalled. Nobody is asked
  twice: once a lead has answered, the ad phrase is just another message. The wording lives at
  the top of [src/campaign.js](src/campaign.js) — edit `GROUPS`, `GROUP_QUESTION` and
  `groupPitch` there. Note the "less than 3.5 months" line is fixed text and will need editing
  as the exam gets closer. `/health` reports the per-group counts under `campaignGroups`.
- **Installments.** The bot may offer the 2-installment split (classes only — the Kit is paid in
  full), but it never states, splits or confirms an amount, due date or schedule, even if the
  student does the arithmetic and asks it to confirm; the team shares the figures. The rule is
  written into both [32-fees-discounts-and-installments.md](knowledge/32-fees-discounts-and-installments.md)
  and [34-fees-installment-close.md](knowledge/34-fees-installment-close.md), and repeated in the
  `fees` trigger prompt. The closing line *"We can also split this into 2 installments if that
  helps. Shall we get you started?"* lives in file 34 and is used only once a lead already knows
  the price and is hesitating — never as an opening offer. **If you edit either file, keep it
  under the 900-character `chunkSize`**: a longer file is split, and the offer can then be
  retrieved without the rule attached. A test guards this.
- **STOP.** A lead who sends just `stop`, `unsubscribe` or `opt out` gets no reply, and the
  bot never answers that number again — whatever they send later, the campaign phrase and `bot`
  included. The number is saved to the `wati_optouts` collection, so a restart does not forget
  it. Remove its document from `wati_optouts` and restart to let the bot talk to them again.
  `/health` reports the count under `whatsappOptOuts`.
- **Human handover.** After a `handover` trigger the bot stays silent for
  `HANDOVER_PAUSE_MINUTES` (default 60) so your agent can take the chat. The customer typing
  `bot` brings it back.
- **Memory.** The last 12 turns per contact are kept in memory and dropped after
  `SESSION_TTL_MINUTES` of silence. It is a `Map` in [src/sessions.js](src/sessions.js) —
  replace it with Redis if you run more than one instance.
- **Grounding.** The model is instructed to answer only from retrieved knowledge chunks and to
  offer a human when it does not know. Retrieval below `KB_MIN_SCORE` is dropped, except when a
  trigger's `kbFilter` already scoped the search to one section.
- **Duplicates.** Repeated webhook deliveries of the same message id are ignored.

## Files

| Path | Role |
|---|---|
| [src/server.js](src/server.js) | Local server startup and indexing |
| [src/app.js](src/app.js) | Express app, browser API, webhook parsing and routes |
| [public/](public/) | Chat playground UI |
| [src/handler.js](src/handler.js) | The brain: trigger → action → reply |
| [src/keywords.js](src/keywords.js) | Trigger loading and matching |
| [src/kb.js](src/kb.js) | Chunking, embedding, cosine search |
| [src/ai.js](src/ai.js) | Retrieval, prompt assembly, OpenAI call |
| [src/providers/openai.js](src/providers/openai.js) | OpenAI chat completion call |
| [src/wati.js](src/wati.js) | WATI send API (session, template, buttons) |
| [src/sessions.js](src/sessions.js) | Per-contact memory, handover pause, de-dup |
| [src/optin.js](src/optin.js) | Campaign-phrase opt-in: which non-allowlisted leads get replies |
# wati_chatbot
