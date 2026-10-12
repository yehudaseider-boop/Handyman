# Handyman

A WhatsApp receptionist workspace for a service business: customer inbox, business knowledge, controlled automatic reception, reviewed AI drafts, a testing lab, job intake and scheduling, human handoff, and an activity log. React + TypeScript frontend, Express API, and persistent SQLite storage. The current workspace is a **single-business, administrator-only application**, not a multitenant SaaS.

## Run locally

Requires Node.js **24.x** and npm. No database service is needed.

```sh
npm ci --cache /workspace/.cache/npm
npm run dev
```

The API listens on port 3001 and Vite on 5173, bound to `127.0.0.1` by default. `APP_ORIGIN` must exactly match the browser origin for sign-in and mutations. The default is `http://127.0.0.1:5173`. `.env` is loaded by the API startup scripts; `.env.example` documents configuration. Do not overwrite an existing `.env`.

Select **Explore the demo workspace** to use fictional customers. Demo credentials are `admin@handyman.local` / `DemoPass!2026`. Demo mode records replies locally and never sends WhatsApp messages. These credentials are rejected in live mode. Keep demo access local.

```sh
npm run check          # Type checking, API/AI tests, production frontend build
npm run test:browser   # Real Chromium workflow and responsive UI checks
npm run benchmark      # Local API latency with 10,003 fictional history messages
```

Browser tests use system Chromium if installed; otherwise install Playwright's Chromium with `npx playwright install chromium`. `CHROMIUM_PATH` can select an existing executable. Tests use isolated temporary / in-memory databases and mocked external providers.

To serve the built app through a single process:

```sh
npm run build
APP_ORIGIN=http://127.0.0.1:3001 npm start
```

## Using the workspace

1. Open **Inbox**, select a conversation, and read the customer's request. Use the demo simulator to receive sample messages.
2. Enable reply drafts in **Reception settings**. **Draft a reply** uses a deterministic template when no AI provider is connected. With a configured provider, **Generate AI draft** sends recent conversation context to OpenAI. Review every draft before sending; drafting itself never delivers a message or confirms a booking.
3. Review the conversation's **Customer request**. Local extraction reads customer messages without contacting an AI provider. Optional AI analysis requires an explicit sharing confirmation. Review the quoted evidence, correct the scope/address/preferred time, and save. Urgent requests and requests for a person pause assistance and flag the conversation for human attention.
4. Convert a complete intake into a linked draft job. Conversion leaves the visit unscheduled and can be retried without creating another job. **Create job for customer** also allows manual entry.
5. Edit the job to assign a team member, visit time, duration, and status. The workspace rejects overlapping scheduled or in-progress jobs for the same assignee. Use **Schedule** to review the week. Dates display in the operator's browser timezone, which the schedule identifies; confirm availability and the customer's timezone before communicating a booking.
6. **Take over** pauses draft assistance for that conversation. Update job progress, resolve conversations, and review **Activity log**. Job schedules are internal records; the team must confirm them with customers.

Intake and job edits carry record versions. If another operator changes a record while you are reviewing it, reload the current record before saving. Intake analysis also refuses stale results if a new customer message arrives while the provider is responding.

The inbox refreshes every five seconds while the tab is visible, with no overlapping polls, and refreshes when you return. Long histories start with the latest 50 messages; **Load earlier messages** opens older pages. New messages offer a jump to the latest while you are reading history. Unsent replies and unsaved intake reviews survive navigation within the signed-in workspace using session-only memory; they clear on sign-out and browser reload. Reply send identifiers also survive workspace navigation so a lost browser response can be retried without creating another message.

**Reception settings → Launch checklist** reports which server configuration is complete and provides the HTTPS webhook callback when live mode is configured. It checks local configuration only. Provider access and real message delivery must still be tested with Meta.

## Business knowledge, automatic reception, and the lab

**Business knowledge** stores services, matching keywords, service areas, FAQs, pricing/booking policies, timezone, and weekly hours. Demo examples are fictional and unapproved; live workspaces start empty. Review and explicitly approve the facts before allowing automatic replies. Saving changes without approval revokes approval and switches reception off.

**Automatic reception** is off by default. When enabled, it uses approved business rules to answer routine questions and gather missing intake details. It never sends unrestricted model output or creates confirmed bookings. Reply limits, a cooldown, business-hours controls, human takeover, and the WhatsApp reply window constrain dispatch. Unsafe, ambiguous, unsupported, and completed-action requests go to a person. Safety and human requests stay paused even when received while automatic reception is off.

**Reception lab** previews conversations using saved knowledge without sending messages or changing customer data. Its 21 sandbox safety scenarios use a separate fictional business and test the rules, not a real model. With an AI key, an optional preview shares the test conversation and bounded approved facts with OpenAI only after confirmation; the resulting draft remains review-only.

Demo automatic responses are recorded locally. Live automatic sending additionally requires `ALLOW_LIVE_AUTOMATION=1`, complete WhatsApp configuration, approved business knowledge, and the operator enable control. Leave the server gate off until a reviewed inbound/outbound exchange and local rule checks pass, then enable it for a controlled test-phone trial. **Turn off automatic reception** stops queued future replies; a reply already submitted to Meta cannot be recalled. See the [reception guide](docs/reception.md) for setup and tests.

## Live WhatsApp and optional AI

Local development and demo validation are complete without external credentials. Real provider connectivity requires your accounts and cannot be proven by demo checks. See [deployment guide](docs/deployment.md) and [security design](docs/security.md).

Configure these values through a secure deployment secret manager, never through chat or source control:

| Variable | Purpose |
| --- | --- |
| `APP_MODE=live` | Turns off demo routes/data and enables provider sends |
| `APP_ORIGIN` | Exact HTTPS origin of the operator workspace |
| `ADMIN_EMAIL` | Administrator bootstrap identity |
| `ADMIN_PASSWORD` | Unique bootstrap password of at least 16 characters |
| `DB_PATH` | Separate persistent live database path |
| `WHATSAPP_ACCESS_TOKEN` | Meta Cloud API token with messaging permission |
| `WHATSAPP_PHONE_NUMBER_ID` | Registered WhatsApp business phone ID |
| `WHATSAPP_APP_SECRET` | Raw Meta app secret for local webhook HMAC verification |
| `WHATSAPP_VERIFY_TOKEN` | Random webhook verification token chosen by you |
| `AI_API_KEY` | Optional OpenAI credential for reviewed AI drafts |
| `AI_MODEL` | Optional model override, defaults to `gpt-4o-mini` |
| `ALLOW_LIVE_AUTOMATION` | Optional explicit live-sending gate; only `1` permits enabling automatic reception |

Webhook: public HTTPS `/webhooks/whatsapp`. Configure Meta's messages webhook subscription and exact phone ID. Provider webhooks are disabled in demo mode. Incoming live webhooks require a valid raw-body HMAC signature. The API verifies webhook challenges with your verification token, deduplicates provider message IDs, and tracks outbound statuses. Non-text media is represented as a notice and requires human follow-up for a written description. Media cannot be opened or transcribed here, and system notices are excluded from AI facts and intake evidence.

Freeform live replies require a customer's inbound message within Meta's 24-hour customer-service window. Approved-template sending outside that window is not implemented. Marketing campaigns, payments, autonomous technician dispatch, and unrestricted model-generated automatic replies are not implemented. AI drafts do not call tools and require operator review before delivery. Controlled automatic reception sends only approved business-rule replies within its limits.

Known provider rejections such as expired credentials or a closed customer-service window produce a failed message and human handoff with a readable explanation. A network timeout or unusable success response remains **unconfirmed** because Meta may have accepted the message. Check delivery before composing a replacement. Signed delivery failures also require human attention, and new customer messages retain an existing handoff.

`ADMIN_PASSWORD` bootstraps the first administrator and does not change an existing user's password on restart. To rotate it, set `DB_PATH`, `ADMIN_EMAIL`, and the new `ADMIN_PASSWORD` securely, then run:

```sh
npm run admin:reset-password
```

This updates an existing administrator and revokes their sessions. It never prints the password. Stop the application first for a controlled maintenance operation.

## Structure

- `src/`: responsive operator workspace.
- `server/`: API, authentication, SQLite data, Meta integration, optional AI adapter.
- `tests/`: security/functional integration tests and browser workflows.
- `docs/`: deployment and security details.
- `data/`: ignored local databases; back up and protect real customer data.

CI runs dependency audit, type checking, integration tests, production build, and browser tests. No live messages are sent by CI.
