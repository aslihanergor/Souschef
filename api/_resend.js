// Resend email client. No npm dep — just fetch. Sends the magic-link email.
// Sends from focus-social.app, a Resend-verified sender domain, so
// magic-link emails deliver to anyone — not just the Resend account owner (the earlier
// onboarding@resend.dev test-mode limitation is gone). `from` must stay on the verified domain.
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const FROM = 'SousChef <login@focus-social.app>';

// Returns true on a sent email, false on any failure (logged server-side). The caller keeps
// its response uniform regardless, so a failure never leaks to the client.
export async function sendMagicLink(email, link) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.error('[resend] RESEND_API_KEY unset — cannot send'); return false; }

  // `link` is our own generated URL (base + random token), not user input.
  const html = `
    <div style="font-family:-apple-system,system-ui,sans-serif;max-width:480px;margin:0 auto;color:#111">
      <h2 style="margin:0 0 12px">Sign in to SousChef</h2>
      <p style="margin:0 0 16px">Click below to sign in. This link works once and expires in 15 minutes.</p>
      <p style="margin:0 0 20px">
        <a href="${link}" style="display:inline-block;background:#111;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none">Sign in to SousChef</a>
      </p>
      <p style="color:#666;font-size:13px;margin:0">If you didn't request this, you can safely ignore this email.</p>
    </div>`;

  try {
    const r = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [email],
        subject: 'Your SousChef sign-in link',
        html,
      }),
    });
    if (!r.ok) {
      console.error('[resend] send failed', r.status, await r.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[resend] send error', e.message);
    return false;
  }
}
