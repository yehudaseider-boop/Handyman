# Security design and operating limits

The application keeps provider credentials on the server. API responses expose configuration status, not credential values. The frontend has no embedded live credentials and renders customer text through React escaping. Automatic reception uses approved deterministic business rules; model-generated drafts remain reviewed proposals.

## Controls

- Administrator passwords use salted scrypt hashes; credentials are never stored as plaintext in SQLite.
- Sign-in verifies passwords asynchronously with at most four concurrent verifications, keeping expensive work off the webhook event loop. Failed-attempt reservations happen before hashing. The stored account and password hash are checked again before creating a session, so rotation or deletion during verification cannot restore access with the old password.
- Sessions use random opaque tokens. Only SHA-256 token hashes are stored. Sessions expire after eight hours, are revoked on logout/password reset, and use HttpOnly, SameSite=Strict cookies. Live mode requires Secure cookies and an HTTPS application origin.
- State-changing API requests require the exact configured Origin, including sign-in. This rejects cross-origin and missing-origin mutations. No permissive CORS is installed.
- Strict input schemas, request-body limits, parameterized SQLite queries, foreign keys, and transaction-backed webhook processing protect data integrity.
- Authentication attempts and API activity are rate limited in the application. Production edge limits are also required, particularly for public webhook traffic. In-memory limits are process-local and reset on restart. The app uses the socket peer address rather than trusting forwarded client headers, so users behind one reverse proxy share its application rate-limit bucket; enforce per-client limits at the trusted edge.
- Webhooks verify the HMAC-SHA256 signature over the original body using constant-time comparison and require the configured phone identity for all live ingress. Demo workspaces reject provider webhooks entirely. Provider IDs are deduplicated. Delayed customer messages do not incorrectly reopen the 24-hour messaging window.
- Security headers include a restrictive Content Security Policy, anti-framing, nosniff, no-referrer, and HTTPS HSTS in live mode. Sensitive API responses use no-store.
- Demo and live databases are explicitly separated. Reusing a demo database in live mode fails closed. Live mode rejects the built-in demo password.
- AI calls use a fixed HTTPS provider, bounded recent conversation context, timeouts, no tools, and validated output. Customer content remains untrusted. The app cannot guarantee a model's factual accuracy, so every draft requires review.
- Provider responses are capped at 64 KiB before JSON decoding. Oversized, invalid, refused, incomplete, and action-bearing AI responses are rejected. Deadlines cover fetching and reading the response body: 12 seconds for AI and 15 seconds for WhatsApp. Browser requests also have finite deadlines; sends are never automatically retried.
- Intake analysis uses only inbound customer messages, with up to 20 messages and 16,000 characters. Extracted scope, address, and preferred time require exact quoted evidence from those messages. Relative times remain customer wording until an operator chooses a visit time. Deterministic urgency and human-request checks cannot be downgraded by the AI response. Local extraction sends no provider request.
- Version checks protect reviewed intake and job edits from stale writes. Intake versions and the customer-message snapshot are checked again after awaited AI responses. Converting an intake uses a database transaction and stores one linked job, so retries return the existing draft.
- Scheduling compares absolute timestamps and durations for scheduled or in-progress jobs. Assignee comparison ignores case and surrounding whitespace. Overlapping appointments for the same assignee are rejected, while adjacent appointments are allowed. Travel time, staff availability, holidays, and external calendars are not modeled; operators must account for those before confirming visits.

## Delivery and AI

A send accepted by Meta is not yet proof the customer received it; delivery/read status comes from signed webhooks. Network timeouts can leave an unconfirmed send. Check the provider before attempting a replacement message. The interface and API use idempotency protection for retries, but this cannot make an external service transaction atomic with SQLite.

Requesting an AI reply draft shares recent conversation text and business reception settings with OpenAI. Requesting AI intake analysis shares recent inbound customer messages. Both require an explicit operator confirmation in the interface. Obtain the appropriate customer consent, review provider data handling, and avoid supplying unnecessary sensitive data. Draft generation or intake extraction must never be treated as confirmation of pricing, service coverage, availability, or a booking.

Reply drafting reads only the latest 12 messages, and intake reads only the latest 20 inbound messages. After an AI draft finishes, the API checks the conversation, assistance settings, and message snapshot again. A takeover, configuration change, or newer customer message prevents an outdated suggestion from becoming the current draft.

Unsent replies, unsaved intake edits, and retry identifiers stay in browser memory during the signed-in workspace session. They are not copied into localStorage and are cleared on sign-out/session expiry. Reloading the browser discards them. The launch checklist is administrator-only, reveals configuration flags instead of credentials, and never treats presence as proof of valid provider access.

## Controlled automatic reception

Business facts and policies have independent versions and explicit approval. Live facts start empty, and both demo and live automatic reception start disabled. A live dispatcher additionally requires complete WhatsApp configuration and `ALLOW_LIVE_AUTOMATION=1`; enabling the operator control without these prerequisites fails closed. AI output is never routed into automatic dispatch.

Each inbound message can be claimed only once, and its outbound identifier is persisted before a provider call. The bounded background queue rechecks approval, exact configuration versions, conversation pause, current message, service window, uncertain sends, cooldown, and reply budgets before dispatch. Rate/cooldown accounting uses persisted send-start times, surviving restart and queue delays. Interrupted sends remain unconfirmed and are handed to a person, never automatically retried. Stale queued work is discarded on configuration edits, off, or restart. One application process remains required.

Safety/human-request classification occurs during inbound ingestion before the webhook acknowledgement, so a later greeting cannot erase a gas leak or request for a person in the same batch. These pauses persist across global off/on changes. Unknown facts, ambiguous matches, media, sensitive-account requests, and attempted rule overrides require human attention. Approved fact replies are length-bounded and checked for recognized completed-action claims or hazardous instructions. These deterministic checks are conservative and do not establish full language understanding; operators must review facts and test relevant wording.

The local simulator and sandbox suite do not call providers, send messages, or write customer records. Optional AI previews require explicit sharing confirmation, rate limits, approved facts, and a version recheck after generation. Drafts, knowledge/policy form edits, and lab transcripts remain in session memory until logout/reload. Replies already submitted to Meta cannot be cancelled by switching reception off.

## Production responsibilities

Run behind HTTPS with network access restricted to required providers. Use a secret manager for raw server-side passwords and HMAC secrets. A proxy-only placeholder is not usable for local scrypt or HMAC operations. Rotate secrets and invalidate old sessions. Grant access only to trusted administrators; there is no role-based staff authorization or multitenant isolation in this release.

SQLite contains customer phone numbers, addresses, conversations, and notes. Protect the storage volume with operating-system access controls and encryption, configure a retention policy appropriate to your business, and test backups/restores. SQLite is designed here for one application instance, not concurrent replicas across a network volume. Application limits do not replace edge denial-of-service protection.

These controls and tests reduce risk; they are not a certification or a claim that all possible vulnerabilities have been eliminated.
