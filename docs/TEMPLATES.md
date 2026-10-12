# Message templates

Drafted by Foreman on 12/10/2026. Yehuda or Yossi approve each one. Statuses: **Draft**, **Approved** or **Changed** (approved, then edited, so it needs approving again). Nothing goes live unless it is Approved.

Rules for every message: South African English, no links, no exclamation marks, short lines that read well on a phone, and no promises the tradesman has not made. `[Business name]` comes from the `BUSINESS_NAME` setting. `{curly}` fields are filled in by the product. Button titles are at most 20 characters.

`C-` messages go to customers, from the tradesman's number. `A-` messages go to the tradesman, from the admin number. `M-` messages are Meta-approved templates for messages sent after the 24-hour window has closed, and each one costs money (D-005).

---

## Customer chat

### C-01 Welcome (new customer). Draft
> Hi, thanks for messaging {tradesman_name}. I'm the office assistant and I'll take a few details so {tradesman_first_name} can get back to you quickly.

Sent about 30 seconds after the first message. Followed straight away by C-02.

### C-02 POPIA consent. Draft. Needs a legal check (Q-04)
> Before we start: {tradesman_name} will keep your name, number, job details, photos and proof of payment to quote, invoice and keep a record of your job. [Business name] stores this securely for {tradesman_first_name}, on servers in the EU. We don't share it with anyone else.
>
> You can ask for your info to be deleted at any time by sending the word *delete*.
>
> Are you happy to go ahead?

Buttons: **I agree** · **No thanks**

### C-03 Consent declined. Draft
> No problem. I won't keep any of your details. {tradesman_first_name} will reply to you personally when he can.

### C-04 Ask name. Draft
> What is your name?

### C-05 Ask contact number. Draft
> Thanks, {customer_first_name}. Is this the best number to reach you on?

Buttons: **Yes, this number** · **Use another**

If **Use another**: "Please type the number."

### C-06 Pick job type. Draft
> What do you need help with?

List button: **Choose job**. Rows: his job types, then **Something else**.

### C-07 Describe the job. Draft
> Please describe the job in a sentence or two. Where is the problem, and how long has it been going on?

### C-08 Ask for a photo. Draft
> If you can, send a photo of the problem. It helps {tradesman_first_name} quote accurately.

Button: **Skip photo**

### C-09 Intake done. Draft
> Thanks, {customer_first_name}. {tradesman_first_name} has your details and will come back to you with a quote. Your reference is *{reference}*.

### C-10 Welcome back (returning customer). Draft
> Hi {customer_first_name}, good to hear from you again. What can {tradesman_first_name} help with this time?

Followed by the C-06 list.

### C-11 Call-out fee. Draft
> {tradesman_first_name}'s call-out fee is *{callout_amount}*. If you go ahead with the job, it is taken off your final invoice.
>
> To book the call-out, please pay into:
> {bank_block}
> Reference: *{reference}*
>
> Then send your proof of payment here.

### C-12 Quote. Draft
> Quote for *{job_type}*
> Reference: *{reference}*
> Date: {date}
>
> {amount_lines}
> *Total: {total}*
>
> Please pay into:
> {bank_block}
> Reference: *{reference}*
>
> Send your proof of payment here once you have paid. {tradesman_first_name} will confirm when the money reflects.

`{amount_lines}` is one line, "Amount: R1 250,00", or for a VAT-registered tradesman three lines: "Subtotal / VAT (15%) / VAT no." [Q-12].

`{bank_block}`:
> Bank: {bank_name}
> Account holder: {account_holder}
> Account no: {account_number}
> Branch code: {branch_code}

### C-13 Updated quote. Draft
> {tradesman_first_name} has updated your quote. This replaces the previous one.

Followed by C-12.

### C-14 POP received. Draft
> Thanks, we've received your proof of payment for *{reference}*. {tradesman_first_name} will confirm once the money reflects in his account.

### C-15 Which job is this POP for? Draft
> Thanks. Which job is this payment for?

List: open references with amounts.

### C-16 Payment confirmed (quote). Draft
> {tradesman_first_name} has confirmed your payment of *{amount}* for *{reference}*. Thank you.

### C-17 Invoice. Draft
> Invoice for *{reference}*
> Date: {date}
>
> {invoice_lines}
> {vat_lines}
> Total: {total}
> Less paid: {less_paid}
> Less call-out fee: {less_callout}
> *Balance due: {balance}*
>
> Please pay into:
> {bank_block}
> Reference: *{reference}*
>
> Send your proof of payment here once you have paid.

The final layout depends on Q-11 and Q-12.

### C-18 Receipt (job closed). Draft
> Receipt for *{reference}*
> Paid in full: *{total_paid}* ({method})
> Date: {date}
>
> Thank you for your business, {customer_first_name}.

### C-19 Confirm delete. Draft
> Do you want us to delete all your info, including photos and job details? This can't be undone.

Buttons: **Yes, delete** · **Keep it**

### C-20 Deleted. Draft
> Done. Your info has been deleted.

### C-21 Not understood. Draft
> Sorry, I didn't catch that. {tradesman_first_name} will see your message and reply personally.

---

## Admin chat

### A-00 Refused (unknown number). Draft
> This number is for registered tradesmen only.

### A-01 Ask PIN. Draft
> Hi {tradesman_first_name}. Please send your 4-digit PIN.

### A-02 Wrong PIN. Draft
> That PIN is wrong. {attempts_left} tries left.

### A-03 Locked. Draft
> Too many wrong PINs. Admin is locked for 30 minutes.

### A-04 Main menu. Draft
> What would you like to do?

List button: **Menu**. Rows: New enquiries · Send quote · Confirm payment · Job done / invoice · Who owes me · Personal numbers · Settings.

### A-05 New enquiry alert. Draft
> *New enquiry* {reference}
> {customer_name}, {customer_phone}
> Job: {job_type}
> "{description}"

Sent with the photo if there is one. Buttons: **Send quote** · **Pause bot** · **Not for me**

### A-06 Confirm quote amount. Draft
> Send quote {reference} to {customer_name} for *{total}*?

Buttons: **Send {total}** · **Change amount** · **Cancel**

### A-07 Ask amount. Draft
> Type the amount in Rand, for example 1500.

### A-08 Check amount (unclear). Draft
> Did you mean *{option_a}* or *{option_b}*?

Buttons: **{option_a}** · **{option_b}**

### A-09 Quote sent. Draft
> Quote {reference} for {total} sent to {customer_name}.

### A-10 POP received alert. Draft
> *Proof of payment* from {customer_name}
> Reference: {reference}
> Amount due: *{amount_due}*
>
> Check your bank before confirming. A POP alone is not proof the money arrived.

Sent with the POP image or PDF. Buttons: **Money received** · **Paid cash** · **Not received**

### A-11 Payment confirmed. Draft
> Marked {reference} as paid ({method}): {amount}. {customer_name} has been told.

### A-12 Ask extras. Draft
> Job done on {reference}. Any extras to add? Type the description and amount, for example: *extra tap washer 85*. Or tap Done.

Button: **No extras / Done**

### A-13 Confirm invoice. Draft
> Invoice for {reference}:
> {invoice_summary}
> *Balance due: {balance}*
>
> Send it to {customer_name}?

Buttons: **Send invoice** · **Edit extras** · **Cancel**

### A-14 Job closed. Draft
> {reference} is closed. {customer_name} has been sent a receipt.

### A-15 Chat paused. Draft
> The bot is paused on {phone}. Send *resume {phone}* to turn it back on.

### A-16 Personal number added. Draft
> {phone} is marked as personal. The bot will never reply to it.

### A-17 Customer deleted their info. Draft
> {reference_list}: the customer asked for their info to be deleted, and it has been. Amounts and references are kept.

### A-18 Setup questions. Draft
One question at a time:
1. "What jobs do you do? Send them one per message, for example *Geyser replacement*. Tap Done when finished."
2. "Do you have a fixed price for *{job_type}*? Type the amount, or tap No fixed price."
3. "What is your call-out fee? Type the amount, or tap No call-out fee."
4. "What is your hourly rate? Type the amount, or tap Skip."
5. "Are you VAT registered?" Buttons: **Yes** · **No**. If yes: "What is your VAT number?"
6. "Bank name?", "Account holder?", "Account number?", "Branch code?"
7. "Choose a 4-digit PIN for the admin chat." Then "Send it again to confirm."
8. Summary of everything, with buttons **All correct** · **Change something**.

### A-19 Who owes me. Draft (should-have)
> *Unpaid*
> {lines: reference, customer, amount, days since sent}
> Total owed: *{total}*

---

## Meta templates (outside the 24-hour window, charged per message)

Category: Utility. Meta approves these separately once the wording is approved here.

### M-01 Invoice ready. Draft
> Hi {customer_first_name}, your invoice for job {reference} from {tradesman_name} is ready. Balance due: {balance}. Reply to this message to see it.

When the customer replies, the window opens and C-17 is sent free of charge.

### M-02 New enquiry alert to tradesman. Draft
> New enquiry {reference} from {customer_name}. Reply to see the details.

### M-03 Payment reminder. Draft (should-have)
> Hi {customer_first_name}, a friendly reminder that {balance} is still due on job {reference} from {tradesman_name}. If you've already paid, please send your proof of payment here.
