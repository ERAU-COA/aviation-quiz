import jwt from 'jsonwebtoken';
import { getSupabase, getClientIp, applyCors } from './_lib.js';

const RATE_WINDOW_MINUTES = 10;
const RATE_MAX_FAILURES = 5;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = getSupabase();
  const ip = getClientIp(req);

  try {
    const { code } = req.body || {};

    if (ip) {
      const since = new Date(Date.now() - RATE_WINDOW_MINUTES * 60 * 1000).toISOString();
      const { count } = await supabase
        .from('audit_log')
        .select('id', { count: 'exact', head: true })
        .eq('event_type', 'instructor_login_failed')
        .eq('ip_address', ip)
        .gte('created_at', since);
      if ((count ?? 0) >= RATE_MAX_FAILURES) {
        return res.status(429).json({ valid: false, error: 'Too many attempts. Wait a few minutes.' });
      }
    }

    const expected = process.env.INSTRUCTOR_CODE;
    if (!expected) {
      return res.status(500).json({ valid: false, error: 'INSTRUCTOR_CODE env var not set on server.' });
    }
    if (typeof code !== 'string' || code !== expected) {
      await supabase.from('audit_log').insert({
        event_type: 'instructor_login_failed',
        ip_address: ip
      });
      return res.status(401).json({ valid: false });
    }

    const token = jwt.sign({ instructor: true, ip }, process.env.JWT_SECRET, { expiresIn: '8h' });
    await supabase.from('audit_log').insert({
      event_type: 'instructor_login_success',
      ip_address: ip
    });
    return res.status(200).json({ valid: true, token });
  } catch (e) {
    console.error('instructor-login error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
