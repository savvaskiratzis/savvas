/**
 * Contact-form endpoint for tsigalogo.gr — runs on Cloudflare, on the site's own origin.
 *
 * Why it exists: the form used to POST to formsubmit.co, which in Sep 2026 put its endpoint
 * behind a Cloudflare bot challenge (HTTP 403 + `cf-mitigated: challenge`, and a preflight
 * with no CORS headers). No `fetch` can solve a JS challenge, so the form silently stopped
 * working for every visitor. This removes the third party entirely: the message goes
 * visitor -> our own Cloudflare -> the practice's inbox, so there is no external form
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
const FROM = { email: "forms@tsigalogo.gr", name: "Ιστοσελίδα tsigalogo.gr" };
const SITE = "https://tsigalogo.gr";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX = { name: 120, email: 160, phone: 40, service: 120, message: 2000 };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

const clip = (v, n) => (v == null ? "" : String(v)).trim().slice(0, n);

export async function onRequestPost(context) {
  const { request, env } = context;
  const wantsJson = (request.headers.get("content-type") || "").includes("application/json");

  const fail = (message, status) =>
    wantsJson ? json({ success: "false", message }, status)
              : Response.redirect(SITE + "/?formerror=1", 303);
  const done = () =>
    wantsJson ? json({ success: "true" })
              : Response.redirect(SITE + "/?sent=1", 303);

  // Only our own pages may use this endpoint. Trivially spoofable, but it stops drive-by
  // abuse from random scripts that find the URL. (The honeypot below catches the rest.)
  const origin = request.headers.get("origin") || request.headers.get("referer") || "";
  if (!origin.startsWith(SITE)) return fail("forbidden", 403);

  let data;
  try {
    data = wantsJson ? await request.json()
                     : Object.fromEntries(await request.formData());
  } catch (e) {
    return fail("bad payload", 400);
  }

  // Honeypot: humans never see the field, bots fill it. Look successful and drop it.
  if (clip(data._honey, 200) !== "") return done();

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

  try {
    const res = await env.SEND_EMAIL.send({
      to: [TO],
      from: FROM,
      replyTo: { email, name },
      subject: "Νέο μήνυμα από το site — " + name,
      text,
    });
    console.log("contact: sent", res && res.messageId);
  } catch (error) {
    // .code is set by the Email Service: E_SENDER_NOT_VERIFIED, E_RATE_LIMIT_EXCEEDED, ...
    console.error("contact: send failed", error && error.code, error && error.message);
    return fail("send failed", 502);
  }

  return done();
}

// Anything that is not a POST (a GET from a curious visitor, a crawler, ...) is not a form.
export async function onRequest() {
  return json({ success: "false", message: "method not allowed" }, 405);
}
