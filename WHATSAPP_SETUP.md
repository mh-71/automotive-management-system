# WhatsApp Business — setup guide

How to connect the workshop's **WhatsApp Business number** to the Social Inbox
(`pages/inbox-whatsapp.html`) through Meta's **WhatsApp Business Platform
(Cloud API)**. The code is in place (migration `0015`,
`src/routes/whatsapp-webhook.js`, `src/routes/whatsapp.js`,
`src/lib/whatsapp.js`); what remains is configuration in Meta and Cloudflare.

**Never paste a token or secret into a chat, an issue, a commit or a file in
this repository.**

---

## What you will end up with

| Worker secret | Where it comes from | Used for |
|---|---|---|
| `WHATSAPP_ACCESS_TOKEN` | Business settings → System users → generate token with `whatsapp_business_messaging` (and `whatsapp_business_management`) | Sending replies |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta app → WhatsApp → API Setup → **Phone number ID** (not the number itself) | Which number sends; only this number's events are stored |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | You invent it (a long random string) | The one-time webhook handshake |
| `META_APP_SECRET` (already set) | Meta app → App settings → Basic → App secret | Verifying every webhook delivery |
| `WHATSAPP_APP_SECRET` (optional) | Only if WhatsApp lives in a **different** Meta app from Messenger | Same, for that app |

Webhook callback URL: **`https://app.taqwa.autos/api/webhooks/whatsapp`**

---

## 1. Before you start: deploy the code and migrate

1. Back up production D1, apply `0015_whatsapp.sql`, then deploy (as in
   `DEPLOYMENT.md`). Until the secrets are set the webhook answers **503** —
   it fails closed.

## 2. Meta app and WhatsApp product

1. <https://developers.facebook.com/apps> → your app (the same one as Messenger
   is simplest) → **Add product → WhatsApp**.
2. Link or create the **WhatsApp Business Account (WABA)** in your Business
   portfolio, and add the workshop's phone number. A number already used in the
   WhatsApp Business **phone app** must be migrated (or use Meta's
   coexistence onboarding, where offered) — read Meta's guidance first.
3. In **WhatsApp → API Setup**, copy the **Phone number ID**.

Meta also gives a free **test number**: it can only message up to 5 recipient
numbers you add under "To". Good for a first end-to-end test.

## 3. Access token

Use a **System User** token (it does not expire with your password):
Business settings → Users → System users → Add → assign the WhatsApp account
and the app → Generate token with `whatsapp_business_messaging` and
`whatsapp_business_management`. The 24-hour temporary token on the API Setup
page is only for a quick test.

## 4. Set the Cloudflare secrets

One at a time, from the repository folder. **Do not pipe values** (PowerShell
adds a line break); paste at the prompt with a right-click, then Enter:

```powershell
npx wrangler secret put WHATSAPP_ACCESS_TOKEN --env production
```
```powershell
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID --env production
```
```powershell
npx wrangler secret put WHATSAPP_WEBHOOK_VERIFY_TOKEN --env production
```

Only if WhatsApp is in a different Meta app than Messenger:

```powershell
npx wrangler secret put WHATSAPP_APP_SECRET --env production
```

Check the names (values are never shown):

```powershell
npx wrangler secret list --env production
```

## 5. Webhook

1. **WhatsApp → Configuration → Webhook → Edit**:
   - Callback URL: `https://app.taqwa.autos/api/webhooks/whatsapp`
   - Verify token: the same value as `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
   - **Verify and save**.
2. **Webhook fields → `messages` → Subscribe.** This one field carries both
   incoming messages and the sent / delivered / read / failed statuses.
3. Make sure the app is **subscribed to the WABA** (the dashboard does this when
   you configure the webhook from the WhatsApp product page).

## 6. Development vs. live

| | App in development mode | App live, permissions approved |
|---|---|---|
| Test number | Messages only the ≤5 numbers you list | — |
| Your own business number | Works for numbers with a role on the app | Any customer |
| Needed | Nothing more | **Business verification**, **App Review** for `whatsapp_business_messaging` (Advanced Access), app set to **Live**, a display name approved by Meta |

## 7. Messaging rules this inbox follows

- Free-form replies only within **24 hours of the customer's last message**
  (WhatsApp's customer service window).
- Outside the window WhatsApp requires an **approved template** — this inbox
  does **not** send templates, so it cannot start conversations or broadcast.
- Media (photos, voice notes, documents) are shown as labels with any caption;
  the inbox does not download media.

## 8. Testing

1. From a phone number allowed by step 6, send a WhatsApp message to the
   business number.
2. **Social Inbox → WhatsApp** shows it within ~15 seconds.
3. Reply: **Sending… → Sent → Delivered → Seen**, or **Not sent** with the
   reason and **Retry**.
4. In Cloudflare → `taqwa-api` → Observability → Events, search
   `whatsapp_delivery`: `"signatureValid":true, "stored":1, "status":200`.

## Troubleshooting (from the `whatsapp_delivery` / `whatsapp_verify` log lines)

| Log | Meaning |
|---|---|
| `whatsapp_verify … "tokenMatched":false` | Verify token in Meta ≠ the secret |
| `whatsapp_verify … "configured":false` | Verify token or App Secret not set |
| `whatsapp_delivery … "signatureValid":false` | The App Secret is from a different Meta app — set `WHATSAPP_APP_SECRET` |
| `"otherNumber":1, "stored":0` | `WHATSAPP_PHONE_NUMBER_ID` is not this number's Phone number ID |
| No line at all | Webhook not subscribed to `messages`, or the sender is not allowed in development mode |
| Reply "Not sent … test recipient list" | Test number: add the customer's number under "To" |
| Reply "… renew the access token" | The token expired or was revoked |
