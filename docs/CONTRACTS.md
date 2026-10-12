# Contracts

Version 0.1, drafted by Foreman on 12/10/2026. Status: **Draft**. This version is based on `AGENTS.md`, and it will be checked against the user cases spreadsheet once that arrives (Q-07). Only Foreman changes this file. Every change bumps the version and is announced to all agents.

Items marked **[Q-xx]** depend on an open owner question. Build them behind a setting so the answer can be switched in without rework.

---

## 1. Two numbers, two chats

| Chat | Number | Provider | Who is on the other side |
| --- | --- | --- | --- |
| **Customer chat** | The tradesman's own number (WhatsApp Business app, connected through Kapso) | Kapso adapter | Customers, plus the tradesman's friends and family |
| **Admin chat** | One shared product admin number (D-008) | Meta Cloud API adapter | Tradesmen only, identified by sender number plus PIN |

Both connect through the same `WhatsAppGateway` interface (section 2). The rest of the code never knows which provider is underneath.

## 2. Message shapes

### 2.1 Inbound (gateway to core)

The gateway checks the webhook signature, **stores the raw payload first** (`inbound_raw`), ignores duplicates by `provider_message_id`, and only then hands the core one of these:

```ts
type InboundMessage = {
  id: string;                    // our UUID
  providerMessageId: string;     // unique; used to ignore duplicates
  channel: 'customer' | 'admin';
  businessNumber: string;        // E.164, the number that received it
  from: string;                  // E.164 sender
  receivedAt: string;            // ISO 8601 UTC
  kind: 'text' | 'button_reply' | 'list_reply' | 'image' | 'document' | 'location' | 'echo' | 'unsupported';
  text?: string;                 // text, or the caption on media
  replyId?: string;              // the id of the button or list row tapped
  media?: { providerMediaId: string; mimeType: string; sha256?: string };
  location?: { lat: number; lng: number; name?: string; address?: string };
  echoTo?: string;               // kind 'echo': the tradesman typed this in his app to this customer
};
```

- `echo` comes from Kapso when the tradesman types in his own app. It is stored and shown in the history, and it **pauses the bot on that chat for 12 hours**, because he has taken over.
- Media is downloaded straight away into private storage. The core gets our `media.id`, never a provider link.

### 2.2 Outbound (core to gateway)

```ts
type OutboundMessage = {
  id: string;                    // our UUID, stored before sending; the idempotency key
  channel: 'customer' | 'admin';
  to: string;                    // E.164
  templateKey: string;           // key from TEMPLATES.md; must have status Approved in live mode
  params: Record<string, string>;
  body:
    | { type: 'text' }
    | { type: 'buttons'; buttons: { id: string; title: string }[] }          // max 3, title max 20 chars
    | { type: 'list'; buttonText: string; rows: { id: string; title: string; description?: string }[] } // max 10 rows
    | { type: 'image'; mediaId: string }
    | { type: 'document'; mediaId: string; filename: string }
    | { type: 'meta_template'; metaTemplateName: string };                 // outside the 24-hour window only
};
```

Rules the gateway enforces on every message:
- **No links.** It refuses any outgoing text that matches `https?://`, `www.` or `wa.me`. This is tested.
- **Approved wording only.** In live mode it refuses any `templateKey` whose status in `TEMPLATES.md` is not Approved. The status is loaded from a generated JSON file at build time.
- If the 24-hour window is closed, only `meta_template` bodies are allowed. Otherwise the core is told `window_closed`.
- Retry with backoff on network errors, at most 3 tries. A timeout is recorded as `unconfirmed`, never resent blindly.

## 3. Database tables (Postgres)

Rules that apply to every table: UUID primary keys, `created_at` and `updated_at` timestamps in UTC, money in **whole cents** as `bigint` with a `CHECK (>= 0)`. Phone numbers are stored in E.164 format.

| Table | Key columns | Notes |
| --- | --- | --- |
| `tradesmen` | `id, display_name, whatsapp_number (unique), admin_sender_number (unique), pin_hash, pin_failed_count, pin_locked_until, callout_fee_cents null, hourly_rate_cents null, vat_registered bool, vat_number null, bank_name, bank_account_holder, bank_account_number, bank_branch_code, ref_prefix (unique, 2 to 4 letters), next_ref_seq, setup_complete bool` | The PIN is hashed with scrypt. `ref_prefix` makes up job references. |
| `job_types` | `id, tradesman_id, name, price_cents null, sort_order, active` | His own list. A customer picks from the active rows. |
| `customers` | `id, tradesman_id, phone, name null, consent_at null, consent_version null, deleted_at null` | One profile per tradesman and phone: unique `(tradesman_id, phone)`. |
| `personal_numbers` | `tradesman_id, phone` | The bot never replies to these numbers. |
| `chat_pauses` | `tradesman_id, phone, paused_until null, reason` | `paused_until` null means paused until he resumes it. |
| `conversation_state` | `tradesman_id, phone, flow, step, data jsonb, expires_at` | Where the customer is in the intake flow. |
| `jobs` | `id, tradesman_id, customer_id, reference (unique), job_type_id, description, status, created_at` | `reference` looks like `JS-1042`. |
| `quotes` | `id, job_id, amount_ex_vat_cents, vat_cents, total_cents, sent_at, version` | A changed amount creates a new version, and only the latest version counts. |
| `invoices` | `id, job_id, subtotal_cents, vat_cents, total_cents, less_paid_cents, less_callout_cents, balance_cents, sent_at` | Maths in Q-11 and Q-12. |
| `invoice_lines` | `id, invoice_id, kind ('quote','extra','callout'), description, amount_cents` | |
| `payments` | `id, job_id, applies_to ('callout','quote','invoice'), method ('eft','cash'), amount_cents, confirmed_by_tradesman_at, pop_media_id null` | **This is the only table that makes anything paid.** |
| `pops` | `id, job_id null, customer_id, media_id, received_at, matched_by ('auto','tradesman'), status ('unmatched','matched','confirmed','rejected')` | A POP is evidence only. |
| `media` | `id, tradesman_id, customer_id null, storage_path, mime_type, sha256, size_bytes` | Private bucket. Deleted with the customer. |
| `inbound_raw` | `id, provider, provider_message_id (unique), payload jsonb, received_at, processed_at null, error null` | Stored first. Can be replayed. |
| `outbound` | `id, channel, to_phone, template_key, params jsonb, status ('queued','sent','delivered','read','failed','unconfirmed'), provider_message_id null, cost_cents null` | `cost_cents` feeds the cost-per-job report. |
| `status_audit` | `id, job_id, from_status, to_status, actor ('customer','tradesman','system'), reason, at` | Written in the same transaction as every status change. |
| `admin_sessions` | `id, tradesman_id, started_at, expires_at` | Created after a correct PIN. |
| `scheduled_tasks` | `id, kind, run_at, payload jsonb, done_at null, attempts` | Used for the 30-second welcome. Run by `pg_cron`. |
| `deletion_log` | `id, tradesman_id, phone_hash, requested_at, completed_at` | Keeps no personal data, only proof that the deletion happened. |

## 4. Job status flow

```
NEW ──(tradesman sends quote)──> QUOTED ──(customer sends POP)──> QUOTE_POP_RECEIVED
  │                                │                                    │
  │                                └────(tradesman: Money received / Paid cash)──┐
  │                                                                     │        │
  │                                     (tradesman: Money received / Paid cash)  │
  │                                                                     ▼        ▼
  │                                                                  QUOTE_PAID
  │                                                                     │ (tradesman: Job done, sends invoice)
  │                                                                     ▼
  │                                                                  INVOICED ──(customer sends POP)──> INVOICE_POP_RECEIVED
  │                                                                     │                                   │
  │                                                                     └──(tradesman: Money received / Paid cash)──┘
  │                                                                                     ▼
  │                                                                                  CLOSED (customer gets receipt)
  └──(tradesman: Cancel, from any status before CLOSED)──> CANCELLED
```

| Change | Who may trigger it | Guard |
| --- | --- | --- |
| to `QUOTED` | Tradesman | His amount is confirmed on screen first. The message includes bank details and the reference. |
| to `*_POP_RECEIVED` | System, when the customer sends an image or PDF | **Never reaches a paid status.** The tradesman is alerted with the POP. |
| to `QUOTE_PAID`, or `CLOSED` from `INVOICE*` | **Tradesman only** | The confirmation screen shows the reference, the amount due and the POP side by side. Writes a `payments` row. |
| to `INVOICED` | Tradesman | Extras and totals are confirmed first. VAT at 15% if he is registered [Q-12]. Balance per [Q-11]. |
| to `CANCELLED` | Tradesman | Not allowed once `CLOSED`. |
| Quote amount changed after it was sent | Tradesman | Creates a new quote version and re-sends it. The status stays `QUOTED`. |

The call-out fee is a separate `payments` row (`applies_to='callout'`) and does not change the job status. It is deducted on the invoice (D-006).

Enforced in the database: a trigger rejects any status change not in this table. `actor='customer'` can never set a paid or closed status.

## 5. Customer chat: what the bot does

1. **First message from an unknown number.** Ignored if the number is personal or the chat is paused. Otherwise a welcome is scheduled for 30 seconds later. It is cancelled if the tradesman replies himself (echo) in the meantime.
2. Consent (C-02), with the buttons **I agree** and **No thanks**. If he picks No thanks, the bot stops and the tradesman is told.
3. Name, then contact number (the "This number" button or type another), one question at a time.
4. Job type: a list built from his active `job_types`, with "Something else" as the last row.
5. Description, then a photo (with a "Skip photo" button).
6. Job created as `NEW`, and the tradesman is alerted. If he has a call-out fee set, it is sent (C-07).
7. **Returning customer** (known phone, not deleted): "Welcome back, [name]", then straight to step 4.
8. Image or PDF while a job is `QUOTED` or `INVOICED`: stored as a POP and matched to that job. With more than one open job, the bot asks which reference it is for.
9. **"Delete my info"** (or "delete", "remove me"): a confirmation with buttons, then deletion (section 7).

## 6. Admin chat commands

He messages the admin number from his registered `admin_sender_number`. The first message in a session asks for his 4-digit PIN. A session lasts 12 hours. Five wrong PINs lock him out for 30 minutes and alert the owners. Any other number gets A-00 (refused) and nothing more.

Taps are the main way to work. Typed commands are shortcuts and are not case sensitive.

| Command or tap | Does |
| --- | --- |
| `menu` | Main menu (list): New enquiries, Send quote, Confirm payment, Job done / invoice, Who owes me, Personal numbers, Settings. |
| `setup` | Guided setup, one question at a time: job types and prices, call-out fee, hourly rate, VAT yes or no (and VAT number), bank details, PIN. Can be re-run per item from Settings. |
| Enquiry alert → **Send quote** | Shows the suggested price for that job type, with the buttons **Send R1 250,00**, **Change amount** and **Cancel**. Change amount: he types a number, it is shown back for confirmation, then sent. |
| `quote JS-1042 1500` | Same as above, typed. Always asks for confirmation before sending. |
| POP alert → **Money received** / **Paid cash** / **Not received** | The confirmation screen shows the reference, the amount due and the POP image. |
| `paid JS-1042`, `cash JS-1042` | Same, typed. |
| **Job done** on a `QUOTE_PAID` job | Asks for extras (description and amount, repeat, or Done), shows the full invoice for confirmation, then sends it. |
| `personal 0821234567` / `unpersonal 0821234567` | Adds or removes a number on the personal list. |
| `pause 0821234567` / `resume 0821234567` | Pauses or resumes the bot on that chat. Every enquiry alert also has a **Pause bot** button. |
| `owes` | Who owes me (should-have). |
| `pin` | Change PIN. |
| `help` | List of commands. |

Amounts he types are parsed as Rand: `1500`, `1 500`, `1500,00`, `R1500` and `1,500.00` all mean R1 500,00. Anything ambiguous, such as `1.500`, is shown back with "Did you mean R1 500,00 or R1,50?" before anything is sent.

## 7. Deleting a customer's info

On a confirmed request: delete the customer's media files, POP files, conversation state and messages, and scrub `customers.name` and `phone`. The tradesman's financial records keep the amounts and references but lose the customer's identity (shown as "Deleted customer"). The tradesman is told. This is logged in `deletion_log` with a hashed phone only.

**[Owners to confirm with the legal check, Q-04]:** whether invoices must be kept with the customer's name for tax purposes. SARS generally requires records to be kept for 5 years. If so, deletion keeps the invoice and removes everything else.

## 8. Formats

- Money: `R1 250,00` (a space between thousands, a comma before the cents). One function, `formatRand(cents)`, is used everywhere and fully tested.
- Dates: `dd/mm/yyyy`, times `HH:mm`, in `Africa/Johannesburg`. Stored in UTC.
- References: `{ref_prefix}-{4-digit seq}`, for example `JS-1042`.
- The product name comes from the `BUSINESS_NAME` setting and is never hard-coded.
