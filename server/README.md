# Amble Beats order API

The website is static (GitHub Pages). Anything that needs a secret runs here, as a Cloudflare Worker with a D1 (SQLite) database:

- creates Razorpay orders at the price set in `src/worker.js` (the browser never sets the amount)
- verifies Razorpay's payment signature, then asks Razorpay whether the money was captured, and for how much
- records every order and enquiry, and emails the sales team when an order is paid or an enquiry arrives
- receives Razorpay webhooks, so a payment still counts if the buyer's browser closes before returning

Duplicate protection: one Razorpay order per checkout attempt (idempotency key), unique payment IDs, an order can only move to `paid` once, and webhook replays are ignored.

## First-time setup (test mode)

You need a Cloudflare account (the free plan is enough), Node 20 or newer, and your Razorpay **test** keys (Dashboard > Account & Settings > API keys, in Test Mode).

```sh
cd server
npm install
npx wrangler login
npx wrangler d1 create amble-orders          # copy the database_id it prints into wrangler.toml
npm run db:init                               # creates the tables
```

In `wrangler.toml`, set `RAZORPAY_KEY_ID` to your `rzp_test_...` key id. Then add the secrets. They are stored by Cloudflare, never in this repository:

```sh
npx wrangler secret put RAZORPAY_KEY_SECRET        # the test key secret
npx wrangler secret put RAZORPAY_WEBHOOK_SECRET    # any long random string; you enter the same one in Razorpay below
npx wrangler deploy                                # prints https://amble-api.<your-subdomain>.workers.dev
```

In the Razorpay Dashboard, still in Test Mode:

1. **Webhooks > Add new webhook.** URL: `https://amble-api.<your-subdomain>.workers.dev/api/razorpay/webhook`. Secret: the same `RAZORPAY_WEBHOOK_SECRET`. Events: `payment.captured`, `payment.failed`, `order.paid`.
2. **Payment capture: automatic.** If it is off, the API captures the payment itself, but automatic is simpler.

On the website, set `apiBase` in `assets/config.js` to the Worker URL and publish. Until `apiBase` is set, the site still works: enquiry forms and the checkout hand the details to WhatsApp instead.

## Test run: do this before going live

Use the test cards and UPI IDs from Razorpay's documentation (for UPI, `success@razorpay` and `failure@razorpay`).

| Check | Expected |
|---|---|
| Pay with a successful test card or UPI | Confirmation page with an order number; row in `orders` with `status = paid`; one email to `NOTIFY_EMAIL` |
| Pay with a failing card or `failure@razorpay`, then close the window | Message on the checkout page with the bank's reason; order stays `created`; `last_error` filled in |
| Press Pay again after a failure | The same order is reused (same `ref`), no second Razorpay order |
| Double-click Pay | One Razorpay order |
| Razorpay Dashboard > Webhooks | Deliveries show `200` |
| Refund a test payment from the dashboard | Works (refunds are issued from the Razorpay dashboard) |

To look at the orders:

```sh
npx wrangler d1 execute amble-orders --remote --command "SELECT ref, status, amount/100 AS rupees, quantity, organisation, phone, last_error, created_at FROM orders ORDER BY created_at DESC LIMIT 20"
npx wrangler d1 execute amble-orders --remote --command "SELECT * FROM leads ORDER BY id DESC LIMIT 20"
```

## Going live

1. Switch the Razorpay Dashboard to Live Mode and generate live keys.
2. Put the `rzp_live_...` key id in `wrangler.toml`, then run `npx wrangler secret put RAZORPAY_KEY_SECRET` with the live secret.
3. Add the same webhook in **Live Mode**, because live and test webhooks are separate. Use a new webhook secret and set it with `wrangler secret put RAZORPAY_WEBHOOK_SECRET`.
4. Make sure `ALLOWED_ORIGINS` contains only `https://amble.invengic.in`. Then run `npx wrangler deploy`.
5. Make one small real purchase, check it end to end, and refund it.

## Email notifications (optional, recommended)

Without these, orders and enquiries are still saved, but nobody is emailed.

1. Create a [Resend](https://resend.com) account and verify the `invengic.in` domain. Resend shows the DNS records to add.
2. Run `npx wrangler secret put RESEND_API_KEY`.
3. Set `MAIL_FROM` (an address on the verified domain) and `NOTIFY_EMAIL` in `wrangler.toml`.

## Changing the price

Change `PRODUCT.unitPrice` (in paise) in `src/worker.js` and deploy. Then update the ₹49,500 shown on the website: `index.html`, `health.html`, `checkout.html` and the JSON-LD block in `index.html`.

## Development

```sh
npm test                    # unit tests: pricing, validation, signatures, captures, webhooks, duplicates
node test/dev-server.mjs    # local API on :8787 with a fake Razorpay, for trying the checkout without keys
```

For the local checkout, serve the site on `http://localhost:8080` and temporarily set `apiBase: 'http://localhost:8787'` in `assets/config.js`. Do not commit that change.
