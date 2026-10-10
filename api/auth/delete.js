// POST /api/auth/delete  → permanently delete the signed-in account.
// Session-gated. Removes the account row (sessions cascade via the FK), the `users` state blob,
// AND the analytics `events` for this account. Neither the state blob nor events would
// be removed by cascade — `users.id` has no FK, and `events.account_id` is `on delete set null`
// (which would *anonymize*, not delete) — so both are explicit, honouring the delete's promise to
// remove the person's data rather than orphan or merely unlink it. All deletes run in one
// transaction so it's all-or-nothing. Irreversible; the client's type-your-email confirm is the
// safeguard. login_tokens for the email carry no state and self-expire — left alone.
import { db } from '../_db.js';
import { OWNER_ACCOUNT, OWNER_DEVICE, isValidUid } from '../_state.js';
import { sessionAccount } from '../_session.js';
import { clearSessionCookie, isSecureRequest } from '../_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }
  const sql = db();
  if (!sql) return res.status(503).json({ error: 'account store unavailable' });

  const account = await sessionAccount(sql, req.headers?.cookie);
  if (!account) return res.status(401).json({ error: 'not signed in' });

  // This browser's device row. It is a snapshot frozen when this browser signed in —
  // afterwards every PUT carried the cookie and landed on the account row. Leaving it behind is
  // what made a deleted account come back: the next boot here is anonymous, so syncOnLoad resolves
  // to this row and restores what we just "deleted".
  //
  // Scoped to the requesting browser ON PURPOSE. Enumerating the account's other devices from
  // `events` was tried and reverted: `events.device_id` is client-supplied and the attribute-on-
  // login sweep claims a device's whole anonymous history for whoever signs in next, so the set
  // includes browsers the account merely touched once — a shared laptop that has been someone
  // else's for a year would have *their* live row deleted. A best-effort analytics log is not an
  // ACL for an irreversible delete. Other devices are therefore NOT handled here, and — importantly
  // — not handled anywhere else either. An earlier version of this comment claimed each one "rotates
  // its own device id on its next sign-out": it cannot. Deleting the account cascades every session
  // row, so the other device's /api/auth/me 401s, renderAccount() hides #acct-in, and #acct-signout
  // is inside it — the only wiring for signOut(). There is no sign-out left to perform.
  // Until that is fixed, another device keeps its local copy until the user clears it by hand.
  //
  // Not a new privilege: knowing a device id already grants full read/write of that row through
  // /api/state (that is the anonymous auth model), so deleting it grants nothing extra.
  // Anonymous `events` for the device are deliberately NOT removed by device_id — the
  // attribute-on-login sweep (api/state.js) has already set account_id on them, so the statement
  // below covers them; a blanket device_id delete would instead cut real DAU history.
  const deviceId = req.headers?.['x-device-id'];
  const statements = [
    sql`delete from events where account_id = ${account.accountId}`, // analytics (set-null FK → explicit)
    // The state blob (no cascade → explicit). `kind` is required: without it this
    // would also delete a device row that happens to carry the same id.
    sql`delete from users where id = ${account.accountId} and kind = ${OWNER_ACCOUNT}`,
    sql`delete from accounts where id = ${account.accountId}`,       // account (sessions cascade away)
  ];
  if (isValidUid(deviceId)) {
    statements.push(sql`delete from users where id = ${deviceId} and kind = ${OWNER_DEVICE}`);
  }

  try {
    await sql.transaction(statements);
  } catch (e) {
    console.error('[auth/delete]', e.message);
    return res.status(500).json({ error: 'delete failed' });
  }

  // Server-side session is gone; clear the cookie so the browser drops it too.
  res.setHeader('Set-Cookie', clearSessionCookie({ secure: isSecureRequest(req.headers) }));
  return res.status(200).json({ ok: true });
}
