# WhatsApp provider check

Checked: 11/10/2026 by Foreman.

**How this was checked.** This build environment blocks direct access to every provider website (Meta, Twilio, Kapso, Supabase). Findings come from web search results limited to each provider's own domain. "Search" means the answer comes from that provider's page as quoted in search results; the page itself was not opened. Anything marked **Unconfirmed** must be checked by opening the page before we rely on it. The owners can lift the block under the environment's Network access settings.

## Summary

| Question | Meta Cloud API (direct) | Kapso | Twilio |
| --- | --- | --- | --- |
| Free for a pilot | Partly. 1 000 free service messages per number per month from 01/10/2026. Templates sent outside the 24-hour window are always charged. | Free plan: 1 connected number only. Pro (3 numbers) costs USD 25 a month. | No. Trial lasts 30 days and includes 100 WhatsApp messages. After that, USD 0.005 per message plus Meta's fees. |
| Tradesman keeps his own number in his normal WhatsApp Business app | Only if we become a Meta "Tech Provider" (business verification plus app review). That is not realistic within one month. | Yes. Supported ("WhatsApp Business App" connect option). The free plan covers 1 number only. | Not found. |
| Buttons and lists | Yes (standard Cloud API). | Yes (passes through to Meta). | Yes. |
| Receive images and PDFs | Yes. | Yes. | Yes. |
| Approved templates | Yes. | Yes. | Yes. |
| Test sandbox | Yes. Meta creates a free test number. No payment method is needed to send templates from it. | Yes. A sandbox number is included on all plans. | Yes. Shared sandbox number, and each tester must send a join code. |
| Reliable incoming delivery | Webhooks with Meta retries. We must store every message first anyway. | Webhooks. | Webhooks. |
| Adds a middleman | No. | Yes. | Yes. |

## Findings, with sources

### Meta pricing changed on 01/10/2026
- Since 01/10/2026 Meta charges per message for **service messages** (replies inside the 24-hour customer service window). Each business number gets **1 000 free service messages per month**. Charging starts at message 1 001, and unused messages do not carry over. Source: [Meta: upcoming pricing updates](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages) and [Meta pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing). Search.
- Without a payment method on file, Meta delivers service messages up to the free tier and **stops delivering after that**. Source: same pages. Search.
- **Utility templates** (messages we start, such as a quote or invoice sent more than 24 hours after the customer's last message) are charged per message and are **not covered** by the free tier. Utility templates sent inside an open window are also charged from 01/10/2026. Source: same pages. Search.
- **South African rate per utility template: Unconfirmed.** It was not in the search results. Meta's rate card must be opened to get it.

### Keeping the tradesman's own number ("coexistence")
- Meta supports a number staying active in the WhatsApp Business app while also connected to the API. South African numbers were added in **April 2026**. Source: [Meta WhatsApp changelog](https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog). Search. The current list of unsupported countries is **Unconfirmed**.
- Only Meta Solution Partners or Tech Providers can connect a number this way. Becoming a Tech Provider needs Meta business verification and then app review. Source: [Onboard WhatsApp Business app users](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/), [Become a Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers). Search.
- The number must be on the **WhatsApp Business** app version 2.24.17 or higher, not the personal WhatsApp app. Messages he types in his app reach us as "echo" events, so the backend sees both sides of the chat. Source: same Meta page and [Meta webhooks](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview/). Search.
- Whether messages he types in his own app are free: **Unconfirmed** on Meta's site. Third-party providers say they are free.
- Kapso supports this through a "WhatsApp Business App" option: he enters his number and pairs his app with a QR code. Limits: display name and calling stay in his app. Source: [Kapso: Connect WhatsApp](https://docs.kapso.ai/docs/how-to/whatsapp/connect-whatsapp). Search.

### Kapso plans
- Free plan: 1 connected number and 2 000 messages a month. Pro: 3 numbers for USD 25 a month, then USD 10 per extra number. Source: [Kapso pricing FAQ](https://docs.kapso.ai/docs/whatsapp/pricing-faq). Search. Meta's own message fees come on top of this.
- Whether a card is needed to sign up: **Unconfirmed**.
- Whether Kapso allows one free account per tradesman: **Unconfirmed**. This needs Kapso's terms, or an email to them.

### Twilio
- Sandbox: shared number, and testers must join with a code. Trial: 30 days, no card needed, 100 WhatsApp messages. Ongoing: USD 0.005 per message in or out, plus Meta's fees. Source: [Twilio sandbox](https://www.twilio.com/docs/whatsapp/sandbox), [Twilio trial](https://www.twilio.com/docs/usage/trials), [Twilio WhatsApp pricing](https://www.twilio.com/en-us/whatsapp/pricing). Search.
- Rejected for the pilot: every message costs money once the 30-day trial ends.

### Business verification and limits
- An unverified business portfolio can start conversations with up to **250** customers in a rolling 24 hours and register up to **2** business numbers. Source: [Meta messaging limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits). Search. That is plenty for 3 to 5 tradesmen.
- Replies to customers who message first are not capped by that limit. **Unconfirmed** wording; check the page.
- What Meta needs for business verification (registration documents, website, domain) and how long it takes: **Unconfirmed**. Still to research.

### Test number
- Meta creates a free test number automatically when we start with Cloud API, with relaxed limits and no payment method needed. Source: [Meta Cloud API Get Started](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started). Search.
- The limit of 5 recipient numbers on the test number that is often quoted: **Unconfirmed**.
