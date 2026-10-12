# Open questions for the owners

Each question has options and Foreman's recommendation. Answered questions move to `DECISIONS.md`.

## Q-01 Whose WhatsApp number do customers message? Open.
**Why it matters:** this decides what customers have to change, how much the tradesman has to change, and what it costs.
- **A. His own number (recommended).** Customers keep messaging him as they do today. His number has to be on the free **WhatsApp Business** app (not personal WhatsApp), and the product connects to it. He keeps chatting in his app as normal, and we see both sides of the chat. Only possible for us through a provider such as Kapso.
  - Cost: Kapso's free plan covers **1** number. For 3 to 5 tradesmen we either (i) open one free Kapso account per tradesman, if Kapso allows it (I will ask them), or (ii) pay for Kapso Pro at USD 25 a month for 3 numbers, plus USD 10 for each extra number.
  - Risk: his friends and family message the same number, so the personal list and pause button are essential.
- **B. One shared number for all tradesmen.** Free on Meta directly (1 000 replies a month), but we need a SIM card for the number. Every tradesman has to tell his customers to message a new number, and the bot has to ask which tradesman they want. That gets in the way of adoption.
- **C. A new number for each tradesman, on Meta directly.** Free, but customers still have to use a new number. Meta allows only 2 numbers until our business is verified.

## Q-02 Card on file for messages we start. Open. Affects the R0 budget.
From 01/10/2026 Meta charges for every message the business starts more than 24 hours after the customer's last message, for example an invoice sent 3 days after the quote. Without a card on file, Meta will not deliver those messages. The South African price per message is still unconfirmed, but it is a few cents per message.
- **A. Put a card on the Meta account with a low spending cap (recommended).** The pilot will cost a few rand a month. I will track the cost per job from day one.
- **B. Stay at R0.** The product may only reply within 24 hours of the customer's last message. When an invoice is late, the tradesman asks the customer to send "invoice" first. That is clumsy, and customers will miss invoices.

## Q-03 Is the call-out fee separate, or taken off the final invoice? Open.
- **A. Taken off the final invoice if the job goes ahead (recommended).** This is common practice and feels fair to customers.
- **B. Always separate.**
- **C. Each tradesman chooses in setup.** This adds a setup question.

## Q-04 POPIA consent wording. Open.
I will draft it in `TEMPLATES.md`. It needs your approval, ideally after a legal check. The check should also cover storing data in the EU (see D-001).

## Q-05 Pilot tradesmen. Open.
I need names, trades and phone models, and whether each one already uses the WhatsApp Business app.

## Q-06 Which company registers the WhatsApp business account? Open.
Meta business verification needs a registered business. Which company is it: ViaTap, a new company, or another one? The pilot can start unverified (up to 250 new conversations a day, 2 numbers), so this does not block week 2.

## Q-07 Source material. Open.
`Tradesman_WhatsApp_User_Cases.xlsx` and the "Build Brief" doc are not in the repo or in Yehuda's Google Drive. I need both before I write the contracts and templates.

## Q-08 Network access for this build environment. Open.
The environment blocks provider websites, so I could only check them through search. Please add these under the environment's Network access settings, Allowed domains: `developers.facebook.com`, `business.whatsapp.com`, `graph.facebook.com`, `docs.kapso.ai`, `api.kapso.ai`, `supabase.com`, `*.supabase.co`. The build also needs them.

## Q-09 Where encrypted nightly backups are kept. Open.
- **A. A private Google Drive folder owned by the business (recommended).** It is free, and the backups are encrypted before upload.
- **B. Inside GitHub.** Not recommended for customer data, even when encrypted.
