import jwt from 'jsonwebtoken';
import { getSupabase, getClientIp, applyCors, findQuizByPassword } from './_lib.js';

const RATE_WINDOW_MINUTES = 5;
const RATE_MAX_FAILURES = 10;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = getSupabase();
  const ip = getClientIp(req);

  try {
    const { password } = req.body || {};

    if (ip) {
      const since = new Date(Date.now() - RATE_WINDOW_MINUTES * 60 * 1000).toISOString();
      const { count } = await supabase
        .from('audit_log')
        .select('id', { count: 'exact', head: true })
        .eq('event_type', 'password_attempt_failed')
        .eq('ip_address', ip)
        .gte('created_at', since);
      if ((count ?? 0) >= RATE_MAX_FAILURES) {
        await supabase.from('audit_log').insert({
          event_type: 'password_attempt_blocked',
          ip_address: ip,
          event_data: { recent_failures: count }
        });
        return res.status(429).json({ valid: false, error: 'Too many attempts. Wait a few minutes and try again.' });
      }
    }

    const quiz = await findQuizByPassword(supabase, password);
    if (!quiz) {
      await supabase.from('audit_log').insert({
        event_type: 'password_attempt_failed',
        ip_address: ip,
        event_data: { length: typeof password === 'string' ? password.length : 0 }
      });
      return res.status(401).json({ valid: false });
    }

    if (quiz.mode === 'sync') {
      return res.status(400).json({ valid: false, error: 'This quiz is in synchronous mode. Wait for instructor to begin.' });
    }

    const token = jwt.sign({ ip, quizId: quiz.id }, process.env.JWT_SECRET, { expiresIn: '6h' });
    await supabase.from('audit_log').insert({
      event_type: 'password_validated',
      ip_address: ip,
      event_data: { quiz_id: quiz.id }
    });

    return res.status(200).json({ valid: true, sessionToken: token, quizTitle: quiz.title });
  } catch (e) {
    console.error('validate-password error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
