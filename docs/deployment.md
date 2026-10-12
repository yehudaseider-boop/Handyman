# Deployment

## Build and start

Use Node 24, a single application instance, and a persistent local disk for SQLite. Install from the lockfile with `npm ci`, run `npm run check` and `npm run test:browser`, then start using `npm start`. The server serves the built frontend from `dist/`.

For a container, `Dockerfile` builds the frontend, removes development dependencies, and runs as the unprivileged `node` user. Bind `/app/data` to persistent storage writable by that user. Set `HOST=0.0.0.0` inside a container. The Docker image defaults to live mode and requires explicit administrator credentials and an HTTPS `APP_ORIGIN`; it does not expose a working default production login. The container was built and smoke-tested locally as the unprivileged user; validate your deployment platform, persistent volume, and TLS routing before rollout.

Terminate HTTPS at a trusted reverse proxy. Restrict direct backend access. Preserve browser Origin headers exactly. Do not enable arbitrary trust-proxy settings or permissive CORS to work around configuration errors. The operator workspace and API use one public origin. Only `/webhooks/whatsapp` needs public provider access independently of administrator sign-in.

Required provider egress is `graph.facebook.com`; optional AI draft egress is `api.openai.com`. npm setup uses `registry.npmjs.org`. The startup scripts enable Node’s supported environment-proxy handling. Never disable certificate verification. In a proxied build environment, forward the standard proxy build arguments and mount your trusted CA as the optional BuildKit secret `build_ca`; it is used only during installation, never included in the image.

## Provider onboarding

1. Register or connect your business WhatsApp phone in Meta, obtain a suitable access token, and subscribe your app to messages for that phone.
2. Store WhatsApp credentials on the server. Supply the raw app secret to the process so local webhook signature validation can work.
3. Set the public HTTPS webhook URL to `/webhooks/whatsapp` and configure the same verification token on Meta and the server.
4. Test using a consenting business-owned test phone. Confirm an inbound text appears once, a reviewed outbound text is accepted, and signed delivery/read notifications update its status.
5. Confirm an old inbound message cannot open a freeform-send window and that an unavailable provider produces a visible delivery error.
6. If using AI, configure `AI_API_KEY`, review privacy requirements, and request a draft. Confirm the text is useful and truthful before enabling it for operators.

Use **Reception settings → Launch checklist** to inspect local configuration and copy the callback URL. A green configuration check does not validate a token's permissions, expiry, Meta subscription, or real phone delivery. During the phone trial, also verify takeover remains paused when the customer replies, a failed delivery triggers human attention, and a repeated operator retry does not duplicate a message. Test model replies against your actual services, supported languages, emergencies, complaints, missing addresses, and ambiguous timing; record response latency before wider use.

No real WhatsApp or OpenAI requests were used to validate this environment because credentials were absent. Automated tests mock provider responses; the live credential/phone check above remains a deployment prerequisite.

Automatic reception is separately gated. Leave `ALLOW_LIVE_AUTOMATION` unset or `0` while setting up the connection and reviewing business facts. Use the Reception lab for offline tests, then conduct the consenting test-phone trial described in [the reception guide](reception.md). Only after that trial, deliberately set the server gate to `1`, restart the single instance, and enable reception through the operator controls. Review the saved limits and hours first. Provider API approval or a saved configuration is not evidence of model accuracy or successful delivery.

## Performance verification

`npm run benchmark` creates an isolated in-memory demo history of 10,003 messages, signs in, and measures 100 conversation-page requests after warm-up. It reports response bytes and median/95th-percentile latency, and checks that the page contains at most 50 messages with earlier history still available. It sends no provider requests and never touches the operator database. This measures local API processing, not real AI latency, network transport, hosting, or browser rendering. Measure those separately on the deployment platform.

Inbox polling runs every five seconds in a visible tab; jobs and schedule refresh every 15 seconds. Polling pauses in a hidden tab. Keep this traffic in mind when sizing edge limits and load testing multiple operator sessions. History queries use an additive ordering index, and older messages load on demand.

## Data and maintenance

Back up using SQLite's online backup mechanism or stop the process before copying database files. Copying only a live `.sqlite` file while WAL writes are active may lose committed data. Protect backups as customer data and test restoration into a separate directory/database. Do not point demo mode at live customer data.

On upgrades, back up the database, install locked dependencies, run the checks, and restart one instance. Startup applies additive SQLite migrations for job fields, customer intake, business knowledge/policies, and automation claims/send times. Existing jobs retain their fields and receive the default assignee `Team`, duration 60 minutes, and version 1. Existing customer data is preserved, while new reception controls remain disabled and unapproved. Review inherited schedules after upgrading: existing appointments may overlap, and the migration does not rewrite them. A demo/live mode mismatch is checked before schema migration and refuses startup.

Do not keep an old and new instance serving the same SQLite volume concurrently. Password rotation uses `npm run admin:reset-password` with securely supplied configuration as described in the README. Provider credential rotation requires restarting the process to refresh bindings.

Before public rollout, set operating policies for customer consent, data retention/deletion, administrator access, emergency messages, booking confirmation, and incident handling. Template messages, media processing, external calendars, and staff roles require separate implementation if your business needs them.
