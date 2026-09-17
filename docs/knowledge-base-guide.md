# Editing the knowledge base

Every file in `knowledge/` is **one topic = one file = one retrieved chunk**. Edit a file,
save, and the bot picks it up on the next message — no restart, no rebuild.

Anything you drop into `knowledge/` is indexed, so notes for humans go in `docs/`, never here.

## The shape of a file

```markdown
# Fees — Pricing for Classes, the Kit and Subjects

Also asked as: फीस, शुल्क, कीमत, கட்டணம், விலை.

Asked as: fee, fees, price, cost, how much, kitna, ...

NEVER share any price, fee, amount or range. Only divert to an executive call.

Send: One of our executives will reach out to you shortly with the pricing details ...
```

| Part | What it does |
|---|---|
| `# Heading` | Names the topic. Must keep its keyword (see the table below). |
| `Asked as:` / `Also asked as:` | The words students actually type. This is what search matches on — the more real phrasings you list, the more often the right file is found. Never sent to the student. |
| Plain lines | The facts, and any instruction to the bot ("Never share a payment link"). Instructions are followed, never sent. |
| `Send:` | The ready WhatsApp reply. The model sends this almost word for word, so write it exactly as you want a student to read it. |

## Three rules

1. **Keep a file under about 800 characters.** Past ~900 it gets cut in half and the second
   half loses its heading. `npm run check:kb` warns you.
2. **Don't rename a file's keyword away.** `knowledge/keywords.json` routes topics by matching
   a word against the filename *and* the heading:

   | Route | Needs this word in the filename or heading |
   |---|---|
   | courses | `course` |
   | fees | `fee` |
   | kit | `kit` |
   | timings | `timing` |
   | admission | `admission` |
   | location | `location` |
   | contact | `contact` |
   | placement | `placement` |
   | payment, payment_status | `payment` |
   | brochure | `brochure` |
   | objections | `objection` |

   Rename freely otherwise — `30-fees-pricing.md` can become `fees.md`.
3. **Never state something we don't publish.** If a fact isn't in these files, the file should
   say so and hand over to the team, the way `60-location-and-address.md` does. That is what
   stops the bot inventing an address, a tutor's qualifications or a placement record.

A file that is background rather than a reply — `81-conversation-read-status.md`,
`99-taglines-and-phrases.md` — carries `<!-- reference-only -->` under its heading. HTML
comments are stripped before indexing, so the marker only tells `check:kb` not to expect an
`Asked as:` or `Send:` line.

## Adding a new topic

1. Create `knowledge/<name>.md` with a `#` heading, an `Asked as:` line and a `Send:` line.
2. Run `npm run check:kb`.
3. Only if it needs its own menu route or a special instruction, add a trigger in
   `knowledge/keywords.json` whose `kbFilter` is a word in the new filename.

## Files today

- `00` — who we are and how we speak
- `10`–`14` — courses: overview, why we're different, how tutors teach, faculty questions
- `20` — class timings and slots
- `30`, `32`, `34` — fees: pricing (diverts to an executive, never quotes a price), discounts
  and installments, the installment close
- `40` — what's inside the Last Attempt Kit
- `50` — admission and joining
- `60`–`62` — location, contact, placement (all hand over to the team)
- `70`–`73` — payment made, payment failed, payment link requests, brochure requests
- `80`–`81` — unanswerable questions, conversation read status
- `90`–`95` — objection handling
- `99` — taglines

Internal sales-call material is in `docs/sales-playbook.md` and is deliberately not indexed.
