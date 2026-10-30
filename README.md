# Susu Steward
## Live link :  https://susu-steward.onrender.com

**An AI agent that runs rotating savings circles on PayPal.**

Rotating savings circles (susu in Ghana, ajo or esusu in Nigeria, tontine in Benin, tanda, chit funds) are how hundreds of millions of people save without a bank. Today they run on notebooks, WhatsApp and trust in one organizer who holds everyone's cash. One mistake, or one dishonest organizer, ends the circle.

Susu Steward keeps the tradition and removes the single point of trust. Members pay each round through **PayPal Checkout**. **Webhooks** confirm every payment. An AI **Steward** prepares the payout, runs a **Payout Risk Check**, and sends it through the **PayPal Payouts API**, holding anything suspicious for the organizer to approve. Every decision lands in an audit log anyone in the circle can read.

> **Sandbox prototype.** The app only talks to the PayPal sandbox. No real money moves. A production version would need payment licensing and a compliance review.

Built for the PayPal AI Hackathon (Devpost). Fresh repository, started during the submission period.

## Features

| Feature | What it does |
| --- | --- |
| **Circle Planner** | Type "6 people, $25 each, every Friday, start Nov 20". The AI turns it into a circle, you confirm it. Works with simple rules if no AI key is set. |
| **Invite and join** | Share a link. Members join with a name and PayPal email. Organizer sets the payout order. |
| **Contributions via PayPal Checkout** | PayPal Orders v2 + JS SDK buttons. Order `custom_id` carries circle, round and member. |
| **Webhooks** | Signature verified with PayPal's verify API, idempotent by event id. Payments land in the ledger even if the browser closes. |
| **Payout Risk Check** | Hard rules can block (not fully funded, wrong recipient order, amount mismatch, duplicate payout). Soft flags and an optional AI review can only escalate to a human, never approve. |
| **Payouts** | PayPal Payouts API batch to the recipient's email, only after the checks pass. High-risk payouts wait for the organizer. |
| **Steward Chat** | Tool-calling agent that answers "Who has not paid?", "When is my turn?" from the real ledger. The tools it used are shown. |
| **Reminder Writer** | Drafts a warm reminder in English, French or Yorùbá (editable). |
| **Late-payment invoice** | One click sends a PayPal Invoice for the missing contribution (Invoicing API). |
| **Dispute summary** | A `CUSTOMER.DISPUTE.CREATED` webhook produces a plain-language summary from the ledger. |
| **Circle health** | Per-member on-time record. Advisory only. |
| **Audit log** | Every tool call, check, payment and payout, visible in the UI. |
| **Demo mode** | Seeded 4-member circle, "view as" switcher, and a time-skip button. |

## Run it

Requirements: **Node.js 22.13 or newer** (uses the built-in `node:sqlite`). **No `npm install` needed**: the project has zero dependencies.

```bash
git clone https://github.com/YOUR-USERNAME/susu-steward.git
cd susu-steward
cp .env.example .env      # then fill in the values below
node server.js            # or: npm start
```

Open http://localhost:3000.

### 1. PayPal sandbox setup

1. Log in at [developer.paypal.com](https://developer.paypal.com), open **Apps & Credentials**, switch to **Sandbox**, create a **Merchant** app.
2. Copy its **Client ID** and **Secret** into `.env` (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`). Enable **Payouts** for the app if the dashboard offers it.
3. Under **Testing Tools > Sandbox Accounts**, keep one **Business** account and create 4 **Personal** accounts (country: United States). Put the 4 Personal emails in `DEMO_EMAILS` (comma separated). Payouts go to those emails.
4. **Webhook (optional but recommended).** Expose the app on a public URL (a Render deploy, or `ngrok http 3000`). In the app settings add a webhook `https://YOUR-URL/api/webhooks/paypal` for: `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.PAYOUTSBATCH.SUCCESS`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`, `PAYMENT.PAYOUTS-ITEM.FAILED`, `CUSTOMER.DISPUTE.CREATED`. Copy the **Webhook ID** into `PAYPAL_WEBHOOK_ID`. Unsigned webhooks are rejected.

### 2. AI model (optional)

Any OpenAI-compatible chat endpoint with tool calling. Set `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` in `.env`. Without a key the app still works, using built-in rules for planning, chat answers and risk checks (the UI says "AI off").

### 3. Try the full flow (about 3 minutes)

1. Open the app, click **Load the demo circle**.
2. Use **view as** to switch between the 4 members. Each one clicks the PayPal button and pays $25 with the matching sandbox Personal account.
3. When the pot is full, view as the organizer (Adaeze) and click **Review and send payout**. The Steward checks, then the Payouts API sends it. The PayPal batch id appears.
4. Next round: view as the next recipient, change their PayPal email, let everyone pay, then propose the payout again. It is **held** with reasons until the organizer approves.
5. Ask the Steward "Who has not paid?" and open "What the Steward looked at".
6. Use **Skip time** to see late members, then try the reminder and invoice buttons.

Judge access: there are no accounts to create. Circles are private by token. Test sandbox logins are the Personal accounts you created in step 3 of the PayPal setup (list them in your submission notes).

## Tests

```bash
npm test
```

Runs the money paths end to end against an in-memory PayPal mock (`PAYPAL_MOCK=1`, tests only): blocked early payout, duplicate payment refusal, automatic low-risk payout, held high-risk payout, approval, webhook idempotency, Steward answers.

## How it is built

```
Browser (plain JS, mobile-first)
   |  JSON over HTTP
Node http server (server.js, no dependencies)
   |-- lib/circles.js   ledger, rounds, contributions (SQLite via node:sqlite)
   |-- lib/payouts.js   Payout Risk Check, guarded send
   |-- lib/steward.js   tool-calling agent, reminders, invoices, dispute summaries
   |-- lib/planner.js   Circle Planner (AI + rules)
   |-- lib/paypal.js    Orders v2, Payouts, Invoicing v2, webhook verification
   '-- lib/ai.js        OpenAI-compatible chat client
```

Safety design: the AI never moves money. It can only call read-only tools. Money leaves only through `payouts.send`, which re-checks hard rules at send time. The AI review can raise concern, never approve. Amounts, recipient and order are verified against the stored ledger, not the client.

## Tools used

- **PayPal**: Orders v2 and JavaScript SDK checkout, Webhooks (verify-webhook-signature), Payouts API, Invoicing API v2, sandbox environment.
- **AI**: any OpenAI-compatible model with tool calling, used for the Circle Planner, Steward Chat, Reminder Writer, payout review and dispute summaries.
- Built with Node.js and SQLite (built-in), plain HTML/CSS/JS.

## Known limits

Single server, SQLite file storage, no user passwords (circle access is by private token link), USD only, sandbox only. These are deliberate prototype choices.

## License

MIT, see [LICENSE](LICENSE).
