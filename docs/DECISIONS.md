# Decisions

Each entry: date, who decided, status, why. "Proposed" means waiting for the owners.

## D-001 Tech stack. Proposed by Foreman, 11/10/2026. Waiting for approval.

**Proposal: TypeScript on Supabase (free plan), with WhatsApp behind a swappable adapter.**

| Piece | Choice | Why |
| --- | --- | --- |
| Language | TypeScript | One language for everything, widely known, strong typing catches money and status mistakes early. |
| Database | Supabase Postgres | Proven database. Status rules and money checks can be enforced in the database itself. |
| File storage (photos, POPs, PDFs) | Supabase Storage, private bucket | Same service as the database: one login, one backup routine. |
| Webhook and logic | Supabase Edge Functions | Receives WhatsApp messages and needs no extra server. |
| Timers (30-second welcome, reminders) | Postgres `pg_cron` with a queue table | Runs inside the database. No extra service. |
| WhatsApp | `WhatsAppGateway` interface with one adapter per provider | The provider can be swapped by writing a new adapter. Nothing else changes. |
| Tests and CI | GitHub Actions, free | Tests run on every change. |
| Secrets | Supabase secrets and GitHub secrets | Never in the code. |
| Hosting region | Supabase EU region (Frankfurt or London) | Closest region to South Africa. See the POPIA note. |

That gives 2 moving parts (Supabase and the WhatsApp provider), plus GitHub.

**Known weak spots on the free plan, and how we handle them** (Supabase limits from [Supabase pricing](https://supabase.com/pricing) and [project pausing](https://supabase.com/docs/guides/platform/free-project-pausing), found by search on 11/10/2026):
- A project with no activity for 7 days is paused. Live pilot traffic keeps it awake, and a daily scheduled check adds a fallback.
- The free plan has no automatic backups. We run a nightly encrypted database dump from GitHub Actions and test a restore before launch. Where the encrypted backups are stored is still to be decided (Q-09).
- Limits are 500 MB of database and 1 GB of files. That is enough for 3 to 5 tradesmen for months, and we will watch usage.
- **Unconfirmed:** whether the free plan allows commercial use, whether signing up needs a card, and whether there is an Africa region. All three must be checked before signing up.

**POPIA note.** Hosting in the EU sends personal information out of South Africa. POPIA section 72 allows this where the recipient is bound by law giving adequate protection (the EU's GDPR is generally accepted as adequate), or with the person's consent. The consent wording will mention it as well. This needs the owners' legal check (Q-04).

**Alternatives rejected:** (from Foreman's own knowledge; not re-checked on 11/10/2026 because provider websites are blocked)
- *Cloudflare Workers with D1 and R2:* free and fast. But file storage (R2) is believed to need a card on file, and it is more pieces to run.
- *Firebase:* Cloud Functions need the paid Blaze plan, which needs a card.
- *Google Cloud Run, AWS, Azure:* need a billing account with a card.
- *Render free web service:* goes to sleep and can take long enough to wake up that the welcome would arrive late.
- *Vercel Hobby:* believed to be for non-commercial use only.
- *A single small server (VPS):* not free, and we would have to run patching and backups ourselves.

## D-002 WhatsApp provider. Proposed by Foreman, 11/10/2026. Depends on Q-01.

- If the owners choose **own number**: Kapso, because it can connect a number that stays in his WhatsApp Business app. Meta's Cloud API would need us to become a Meta Tech Provider first, and that will not happen within a month.
- If the owners choose **shared number**: Meta Cloud API directly, with no middleman and no middleman fees.
- Twilio is rejected either way because it charges for every message once the trial ends.
- Either way, development starts on Meta's free test number or Kapso's sandbox, through the same adapter.

Findings and sources: `docs/PROVIDERS.md`.

## D-003 Codex web-dashboard prototype moved off main. Decided by Yehuda, 12/10/2026.

A Codex commit (`714b3b9`, 12/10/2026) put a web dashboard prototype on `main`: a receptionist inbox, scheduling, and OpenAI drafts, with an Express and SQLite backend. Its 127 tests passed when Foreman ran them. It does not match the brief: it uses web pages instead of WhatsApp only, it has none of the money features (quotes, POP, invoices, VAT, cash, receipts), it has no POPIA consent or deletion, it has no tradesman number plus PIN, it does not handle media, and it uses paid OpenAI.

Decision: the commit is kept untouched on the `gpt-workspace` branch and reverted on `main`. The brief and project docs go onto `main`, so every agent works from them.

Worth reusing later, by the gateway builder: the webhook HMAC signature check, deduplication by provider message ID, and the 24-hour window handling (`server/app.ts` on `gpt-workspace`).

## D-004 Customers message the tradesman's own number, through Kapso. Decided by Yehuda, 12/10/2026 (Q-01).
- Each pilot tradesman's number moves to the free **WhatsApp Business** app if it is not there already, and is connected to Kapso. He keeps chatting in his app as normal.
- First, ask Kapso whether each tradesman may have his own free account. If not, Kapso Pro (USD 25 a month for 3 numbers) comes back to the owners as a spending decision. Nothing is paid without that approval.
- Consequence: the tradesman cannot send admin commands to his own number. See D-008.

## D-005 Card on the Meta account with a low spending cap. Decided by Yehuda, 12/10/2026 (Q-02).
Templates sent outside the 24-hour window are needed for invoices and enquiry alerts. The owners add the card themselves. The cap amount is still to be agreed (Q-13). The cost per job is tracked from day one.

## D-006 The call-out fee is deducted from the final invoice if the job goes ahead. Decided by Yehuda, 12/10/2026 (Q-03).
If no job follows, the call-out fee stands on its own. The invoice shows it as a separate "Less: call-out fee paid" line.

## D-007 Encrypted nightly backups go to a private Google Drive folder owned by the business. Decided by Yehuda, 12/10/2026 (Q-09).
Backups are encrypted before upload. The key is kept out of Drive and out of the code. The restore is tested before launch.

## D-008 Admin chat runs on a separate product number. Proposed by Foreman, 12/10/2026.
Because customers message the tradesman's own number (D-004), his admin commands and alerts need a second number: one **admin number** run by the product and shared by all tradesmen, connected directly to Meta's Cloud API. Admin replies count as service messages, which are free up to 1 000 a month. He saves it in his contacts, for example as "[Business name] Office". He is identified by the number he messages from plus his PIN. This means each tradesman needs a second WhatsApp number of his own to message from (most phones take two SIMs), or a family member's phone. That is checked in Q-05 and Q-10.
