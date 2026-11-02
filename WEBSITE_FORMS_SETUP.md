# Website Forms — connecting taqwa.autos to the CRM

The public website's source is **not in this repository**, so the website
change below has to be made in the website project. The CRM side (migration
`0016`, `src/routes/website-forms.js`, the Website Forms page) is done.

## The endpoint

```
POST https://app.taqwa.autos/api/forms/submit
Content-Type: application/json
```

| Field | Required | Notes |
|---|---|---|
| `formType` | no | `booking` (default), `quote` or `contact` |
| `name` | **yes** | up to 120 characters |
| `phone` | **yes** | digits, spaces, `+ - ( )`; 6–15 digits |
| `email` | no | checked when given |
| `service` | no | e.g. "AC Service", "LPG Conversion" |
| `vehicle` | no | make and model |
| `regNo` | no | registration number |
| `preferredDate` | no | `YYYY-MM-DD`, today or later (Dhaka) |
| `preferredTime` | no | `HH:MM`, 24-hour |
| `message` | contact forms: **yes** | up to 2000 characters |
| `sourcePage` | no | the page path, e.g. `/book` |
| `company` | — | **honeypot**: a hidden, empty field; must stay empty |
| `startedAt` | — | `Date.now()` when the form was opened (spam check) |

Answers:

| Status | Body | Show the visitor |
|---|---|---|
| 201 | `{ data: { reference }, message }` | the success message + reference |
| 200 | `{ data: { reference, duplicate: true } }` | "We already have your request" |
| 422 | `{ error: { fields: { name: "…" } } }` | each message next to its field |
| 429 | `{ error: { message } }` | the message (too many requests) |
| 403 / 5xx | `{ error: { message } }` | "Please call us" |

Only `https://taqwa.autos` and `https://www.taqwa.autos` may call it from a
browser. Another origin (a staging site, local development) is added with the
Worker variable `FORMS_ALLOWED_ORIGINS` (comma-separated). **No secret or key
is needed in the website** — nothing private belongs in website code.

## The website change

Add a hidden honeypot field to each form, keep the existing visible fields
(the `name` attributes must match the table above), and submit with:

```html
<!-- inside the existing <form id="bookingForm">, anywhere -->
<input type="text" name="company" tabindex="-1" autocomplete="off" aria-hidden="true"
       style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0">
<p class="form-status" role="status" aria-live="polite"></p>
```

```js
(function () {
  const form = document.getElementById('bookingForm');   // the existing form
  const status = form.querySelector('.form-status');
  const button = form.querySelector('[type="submit"]');
  const startedAt = Date.now();
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (button.disabled) return;                         // no double submit
    button.disabled = true;
    status.textContent = 'Sending…';
    const data = Object.fromEntries(new FormData(form));
    data.formType = form.dataset.formType || 'booking';
    data.sourcePage = location.pathname;
    data.startedAt = startedAt;
    try {
      const res = await fetch('https://app.taqwa.autos/api/forms/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        status.textContent = body.data && body.data.duplicate
          ? 'We already have your request. We will contact you soon.'
          : `Thank you! Your request has been received (ref. ${body.data.reference}). We will call you shortly.`;
        form.reset();
      } else if (res.status === 422 && body.error && body.error.fields) {
        status.textContent = Object.values(body.error.fields).join(' ');
        button.disabled = false;
      } else {
        status.textContent = (body.error && body.error.message) || 'Sorry, something went wrong. Please call us.';
        button.disabled = false;
      }
    } catch {
      status.textContent = 'Sorry, we could not send your request. Please check your connection or call us.';
      button.disabled = false;
    }
  });
})();
```

## Deploying (needs approval)

1. Back up production D1, apply `0016_website_forms.sql`, deploy the Worker.
2. Make the website change above and publish the website.
3. From the website, send one test booking with fictional details; it should
   appear under **Social Inbox → Website Forms** as **New**. Mark it
   **Rejected** afterwards.
4. Worker logs show one `website_form` line per submission (`stored`,
   `duplicate`, `spam_suspected` or `rate_limited`) — never the visitor's details.

The existing read-only proxy of the old booking service
(`/api/website-bookings`, shown in Appointments) is unchanged; once the website
sends to this endpoint, that proxy can be retired in a separate change.
