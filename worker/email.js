/* Magic-link delivery via ToSend — https://tosend.com/docs/api/send-email/
 *
 *   POST https://api.tosend.com/v2/emails
 *   Authorization: Bearer <TOSEND_API_KEY>
 *   { from: {name, email}, to: [{email}], subject, text, html }
 *   -> 200 { message_id } | 401 unauthorized | 403 forbidden | 422 validation_error
 *
 * Set TOSEND_API_KEY (and optionally MAIL_FROM) as secrets and mail goes out for
 * real; leave them unset and the link is written to the Worker log instead, which
 * is how local development works.
 *
 * The link is NEVER returned in an HTTP response. Echoing it would turn the dev
 * convenience into a total authentication bypass the moment it shipped, so the
 * only way to read it without mail configured is to have log access.
 */

const ENDPOINT = "https://api.tosend.com/v2/emails";
const DEFAULT_FROM = { name: "mdread", email: "login@mdread.app" };

/* MAIL_FROM is a convenience for operators, so accept either an RFC 5322 string
   ("mdread <login@mdread.app>") or a bare address, and hand ToSend the object
   shape its API actually wants. */
function parseFrom(raw) {
  if (!raw) return DEFAULT_FROM;
  const m = String(raw).match(/^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/);
  if (m) return { name: m[1].replace(/^"|"$/g, "") || DEFAULT_FROM.name, email: m[2] };
  return { name: DEFAULT_FROM.name, email: String(raw).trim() };
}

const bodyText = (link) =>
  [
    "Open this link to sign in to mdread:",
    "",
    link,
    "",
    "It expires in 15 minutes and can only be used once.",
    "",
    "Signing in only restores the list of share links you've created. You'll",
    "still need your master password to decrypt it — mdread does not have it",
    "and cannot reset it.",
    "",
    "If you didn't ask for this, you can ignore this email.",
  ].join("\n");

const bodyHtml = (link) => `<!doctype html>
<div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;max-width:34rem;margin:0 auto;padding:2rem 1.5rem;color:#2c2620;line-height:1.55">
  <h1 style="font-size:1.25rem;font-weight:600;margin:0 0 1rem">Sign in to mdread</h1>
  <p style="margin:0 0 1.5rem">Open this link to sign in. It expires in 15 minutes and can only be used once.</p>
  <p style="margin:0 0 1.75rem">
    <a href="${link}" style="display:inline-block;background:#b6502f;color:#faf6ee;text-decoration:none;padding:.7rem 1.3rem;border-radius:9px;font-size:.95rem">Sign in</a>
  </p>
  <p style="margin:0 0 1.5rem;font-size:.85rem;color:#5b5347">
    Signing in only restores the list of share links you've created. You'll still need your
    <strong>master password</strong> to decrypt it — mdread does not have it and cannot reset it.
  </p>
  <p style="margin:0;font-size:.8rem;color:#8c8474">
    If you didn't ask for this, you can ignore this email. The link below is the same as the button above.<br>
    <span style="word-break:break-all">${link}</span>
  </p>
</div>`;

export async function sendMagicLink(env, email, link) {
  if (!env.TOSEND_API_KEY) {
    console.log(JSON.stringify({ msg: "auth.magic_link.dev", link }));
    return { delivered: false, reason: "no-mail-provider" };
  }

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.TOSEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: parseFrom(env.MAIL_FROM),
        to: [{ email }],
        subject: "Your mdread sign-in link",
        text: bodyText(link),
        html: bodyHtml(link),
      }),
    });
  } catch (err) {
    console.error(JSON.stringify({ msg: "auth.mail_unreachable", error: String(err) }));
    throw new Error("Could not send the sign-in email");
  }

  if (!res.ok) {
    // ToSend returns { status_code, error_type, message, errors }. Log enough to
    // diagnose (an unverified sending domain is the usual 422) but never the
    // recipient address or the link.
    const detail = await res.json().catch(() => ({}));
    console.error(
      JSON.stringify({
        msg: "auth.mail_failed",
        status: res.status,
        error_type: detail.error_type,
        detail: String(detail.message || "").slice(0, 300),
      })
    );
    throw new Error("Could not send the sign-in email");
  }

  const { message_id } = await res.json().catch(() => ({}));
  console.log(JSON.stringify({ msg: "auth.mail_sent", message_id }));
  return { delivered: true, messageId: message_id };
}
