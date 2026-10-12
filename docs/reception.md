# Set up controlled reception

The system has two separate reply paths. OpenAI drafts are suggestions for a person to review. Automatic reception uses bounded business rules and approved facts; it never delivers arbitrary model output. The local lab can test both paths without sending WhatsApp messages.

## Prepare the facts

1. Open **Business knowledge**. Replace the fictional demo examples with the actual services you offer, clear descriptions, matching words, and service areas. Live workspaces start empty.
2. Add FAQs with accurate answers and matching words. Enter pricing and booking policies without promising an appointment, a technician, or a job-specific price that has not been confirmed. Unknown or ambiguous questions are handed to a person.
3. Set the business timezone and weekly hours. The opening time is included, and closing time is excluded. Overnight shifts, holidays, travel buffers, and individual staff availability are not modeled by these reception hours.
4. Select **I reviewed these business facts** and save. Services and service areas are required for approval. Later edits uncheck approval; saving unapproved facts disables reception and cancels queued decisions.

Facts have versions. Another operator's edit causes a conflict rather than silently overwriting it. Reloading a record explicitly discards the current form. Unsaved edits survive navigation in the signed-in workspace but not browser reload.

## Test in the lab

Open **Reception lab**, add customer or receptionist turns, and select **Preview reception decision**. The preview uses current saved facts, with automatic reception treated as enabled for testing; knowledge approval and business-hours rules still apply. It does not use a customer's actual reply allowance or change a customer conversation.

Try a greeting, supported service request, pricing question, location outside coverage, complete job intake, ambiguous question, complaint, human request, gas leak, attempted rule override, and payment-secret request. Add a harmless greeting after the gas leak or human request and verify that the pending handoff is retained. The decision explains whether a reply, handoff, or no response is appropriate.

**Run safety checks** evaluates 21 scenarios against an isolated fictional business. This checks control behavior; it does not certify the real model, your particular facts, or live delivery. Optional **Preview AI draft** appears when OpenAI is configured and requires sharing confirmation. It sends the sandbox conversation and bounded approved business facts to OpenAI, then returns a review-only draft. It sends nothing to WhatsApp.

## Enable local demo reception

Open **Automatic reception**, review the limits and business-hours setting, and enable it after approving the facts. In demo mode, simulate a customer message in Inbox. A permitted reply is recorded locally; uncertain or unsafe requests pause the conversation for a person. No external messages are sent.

The conversation budget counts automatic replies in a rolling 24-hour period. The per-minute budget covers the whole workspace. Cooldown/rate/budget limits result in human handoff instead of an unbounded reply loop. Use **Take over** for any individual conversation. **Turn off automatic reception** remains independent of invalid unsaved limit fields and stale form versions. It stops queued future replies without changing other saved limits; in-flight messages already submitted cannot be recalled.

## Live test and activation

Complete the Meta setup, HTTPS deployment, signed-webhook subscription, and consenting test-phone checks first. Leave the live automatic-sending server gate off while verifying a reviewed inbound/outbound exchange. Then deliberately set `ALLOW_LIVE_AUTOMATION=1`, restart the single application instance, and enable the operator control for a controlled phone trial.

Verify the routine answer is an approved fact, duplicate webhook delivery produces one reply, intake is collected without a booking promise, takeover and off block future sends, dangerous requests remain handed off, limits work, and provider failures remain visible. A send accepted by Meta still needs signed delivery/read callbacks. An uncertain send is not retried automatically.

A cold restart never resumes old queued work or retries interrupted sends. It preserves customer data and hands interrupted automation to a person. The dispatcher uses one process with SQLite; do not run replicas on the same database.
