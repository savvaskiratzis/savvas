/**
 * Contact-form endpoint for tsigalogo.gr — a Worker, with the Email Service binding.
 *
 * This runs on the site's own domain (route: tsigalogo.gr/api/contact) and sends the enquiry
 * to the practice's inbox, so there is no third-party form processor and no CORS.
 *
 * History that matters: the form used to POST to formsubmit.co, which put its endpoint behind
 * a Cloudflare bot challenge in Sep 2026 (403 + `cf-mitigated: challenge`, no CORS headers on
 * the preflight), which no `fetch` can solve -- the form was dead for every visitor.
 *
 * The identical logic also exists as a Pages Function (functions/api/contact.js). That copy is
 * the fallback: if this Worker or its route is ever removed, the Pages Function still answers
 * honestly (503, "call or email") instead of letting the form fail silently. Keep them in sync.
 *
 * Requires:
 *   - Email Routing enabled for tsigalogo.gr (done)
 *   - the recipient added as a VERIFIED destination address (free on all plans)
 *   - the SEND_EMAIL binding, declared in wrangler.toml
 */

const TO = { email: "tsiga.kat@gmail.com", name: "Κατερίνα Τσίγα" };
const FROM = { email: "forms@tsigalogo.gr", name: "Ιστοσελίδα tsigalogo.gr" };
const SITE = "https://tsigalogo.gr";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX = { name: 120, email: 160, phone: 40, service: 120, message: 2000 };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    // X-Contact-Endpoint lets the health check prove WHICH layer answered: the Worker (route
    // present) or the Pages Function (fallback). If both look identical, a lost route is
    // invisible until a real enquiry goes missing.
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Contact-Endpoint": "worker",
    },
  });

const clip = (v, n) => (v == null ? "" : String(v).trim().slice(0, n));

async function handleContact(request, env) {
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
    console.error("contact: SEND_EMAIL binding missing");
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/contact") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return json({ success: "false", message: "method not allowed" }, 405);
    return handleContact(request, env);
  },
};
