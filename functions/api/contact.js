/**
 * Contact-form endpoint for tsigalogo.gr — runs on Cloudflare, on the site's own origin.
 *
 * Why it exists: the form used to POST to formsubmit.co, which in Sep 2026 put its endpoint
 * behind a Cloudflare bot challenge (HTTP 403 + `cf-mitigated: challenge`, and a preflight
 * with no CORS headers). No `fetch` can solve a JS challenge, so the form silently stopped
 * working for every visitor. This removes the third party entirely: the message goes
 * visitor -> our own Cloudflare -> Katerina's inbox, so there is no external form
 * processor to declare in the privacy policy and no external service to break us again.
 *
 * Requires, in the Pages project (dashboard -> Settings -> Functions):
 *   1. Email Routing enabled for tsigalogo.gr, with the address in TO added and VERIFIED
 *      (Cloudflare only allows sends to verified destinations -- which is also what makes
 *      this free on the Workers Free plan).
 *   2. an Email Service binding named SEND_EMAIL (that name is what `env.SEND_EMAIL` reads).
 *
 * If either is missing the endpoint fails loudly instead of pretending to save the enquiry:
 * the site's JavaScript turns that into "call or email instead".
 *
 * Every reply respects the caller: JSON for the site's fetch(), a 303 back to the contact
 * section for the no-JS fallback -- nobody ever sees raw JSON in a browser.
 */

const TO = { email: "tsiga.kat@gmail.com", name: "Κατερίνα Τσίγα" };
// Safety copy (owner's request, 18/9/2026): if one inbox filters a message, the other keeps it.
// Cloudflare only sends to VERIFIED destinations -- which is also what makes this free.
const CC = { email: "savvaskiratzis@gmail.com", name: "Savvas Kiratzis" };
const FROM = { email: "forms@tsigalogo.gr", name: "Ιστοσελίδα tsigalogo.gr" };
const SITE = "https://tsigalogo.gr";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX = { name: 120, email: 160, phone: 40, service: 120, message: 2000 };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    // See worker/src/index.js: this is the fallback layer, and it says so.
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Contact-Endpoint": "pages-function",
    },
  });

const clip = (v, n) => (v == null ? "" : String(v).trim().slice(0, n));

export async function onRequestPost(context) {
  const { request, env } = context;
  const wantsJson = (request.headers.get("content-type") || "").includes("application/json");

  const fail = (message, status) =>
    wantsJson ? json({ success: "false", message }, status)
              : Response.redirect(SITE + "/?formerror=1", 303);
  // The id proves the Email Service actually accepted a message (it only exists after a
  // successful send), which is what the health checks rely on instead of guessing.
  const done = (id) =>
    wantsJson ? json(id ? { success: "true", id } : { success: "true" })
              : Response.redirect(SITE + "/?sent=1", 303);

  // Only our own pages may use this endpoint. Trivially spoofable, but it stops drive-by
  // abuse from random scripts that find the URL. (Appeal abuse control is really the zone
  // rules; see the note below about the missing rate limit.)
  //
  // ΔΥΟ ΔΙΟΡΘΩΣΕΙΣ ΑΣΦΑΛΕΙΑΣ (19/9/2026, από έλεγχο ασφάλειας):
  //  1. Η απόρριψη ΔΕΝ περνά από το `fail()`: εκείνο, στη μη-JSON διαδρομή, κάνει πάντα
  //     Response.redirect(303) και ΑΓΝΟΕΙ το status — δηλαδή ένα ξένο origin έπαιρνε redirect
  //     αντί 403 (αποδείχθηκε με αίτημα text/plain: 303, ενώ με application/json: 403). Η
  //     αποστολή μπλοκαριζόταν, αλλά ο κωδικός έλεγε ψέματα σε κάθε monitoring.
  //  2. Ο έλεγχος ήταν `startsWith(SITE)`: το `Origin: https://tsigalogo.gr.evil.com` περνούσε.
  //     Τώρα γίνεται κανονικοποίηση με URL και σύγκριση ORIGIN — ακριβής αντιστοίχιση.
  const ownOrigin = (u) => {
    if (!u) return false;
    try { return new URL(u).origin === SITE; } catch (e) { return false; }
  };
  const origin = request.headers.get("origin") || request.headers.get("referer") || "";
  if (!ownOrigin(origin)) {
    return wantsJson ? json({ success: "false", message: "forbidden" }, 403)
                     : new Response("forbidden", { status: 403 });
  }

  let data;
  try {
    data = wantsJson ? await request.json()
                     : Object.fromEntries(await request.formData());
  } catch (e) {
    return fail("bad payload", 400);
  }

  // NO honeypot (removed 18/9/2026). It was an autofill trap: on a phone the browser filled the
  // hidden field, so the form told the owner "δεν ήταν δυνατή η αποστολή" and his message was
  // never even sent. A guard that silently eats real enquiries is worse than the spam it stops;
  // abuse control lives in the origin check, the per-device quota and Cloudflare's zone rules.

  const name = clip(data.name, MAX.name);
  const email = clip(data.email, MAX.email);
  const phone = clip(data.phone, MAX.phone);
  const service = clip(data.service, MAX.service);
  const message = clip(data.message, MAX.message);

  if (!name || !EMAIL_RE.test(email) || message.length < 10) return fail("invalid fields", 400);

  if (!env.SEND_EMAIL || typeof env.SEND_EMAIL.send !== "function") {
    console.error("contact: SEND_EMAIL binding missing (see the note at the top of this file)");
    return fail("email binding not configured", 503);
  }

  const text = [
    "Νέο μήνυμα από τη φόρμα του tsigalogo.gr",
    "",
    "Ονοματεπώνυμο: " + name,
    "Email: " + email,
    "Τηλέφωνο: " + (phone || "—"),
    "Υπηρεσία: " + (service || "—"),
    "",
    "Μήνυμα:",
    message,
    "",
    "— Στάλθηκε από τη φόρμα επικοινωνίας. Απαντήστε απευθείας σε αυτό το email.",
  ].join("\n");

  const mail = {              // NOT `message`: that name is already the visitor's text
    from: FROM,
    replyTo: { email, name },
    subject: "Νέο μήνυμα από το site — " + name,
    text,
  };
  let res;
  try {
    res = await env.SEND_EMAIL.send({ ...mail, to: [TO], cc: [CC] });
    console.log("contact: sent to both inboxes", res && res.messageId);
  } catch (error) {
    // The safety copy must never cost Katerina her message. If the combined send fails (the
    // second address not verified yet, a per-recipient rate limit, ...), retry to Katerina's inbox
    // alone -- a lost enquiry is far worse than a missing copy.
    console.error("contact: both-recipient send failed, retrying to Katerina only",
                  error && error.code, error && error.message);
    try {
      res = await env.SEND_EMAIL.send({ ...mail, to: [TO] });
      console.log("contact: sent to Katerina only", res && res.messageId);
    } catch (retryError) {
      // .code: E_SENDER_NOT_VERIFIED, E_RATE_LIMIT_EXCEEDED, ...
      console.error("contact: send failed", retryError && retryError.code, retryError && retryError.message);
      return fail("send failed", 502);
    }
  }
  return done(res && res.messageId);

  return done();
}

// Anything that is not a POST (a GET from a curious visitor, a crawler, ...) is not a form.
export async function onRequest() {
  return json({ success: "false", message: "method not allowed" }, 405);
}
