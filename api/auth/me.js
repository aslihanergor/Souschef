// GET /api/auth/me  → { email } for a valid session, else 401 (TASK-025).
import { db } from '../_db.js';
import { sessionAccount } from '../_session.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  const sql = db();
  if (!sql) return res.status(503).json({ error: 'auth unavailable' });

  const account = await sessionAccount(sql, req.headers?.cookie);
  if (!account) return res.status(401).json({ error: 'not signed in' });
  return res.status(200).json({ email: account.email });
}
