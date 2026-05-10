import jwt from 'jsonwebtoken';
import { getSupabase, getClientIp, applyCors, findQuizByPassword } from './_lib.js';

const RATE_WINDOW_MINUTES = 5;
const RATE_MAX_FAILURES = 10;
const DEVICE_ID_PATTERN = /^[a-f0-9-]{8,64}$/i;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = getSupabase();
  const ip = getClientIp(req);

  try {
    const { password, deviceId } = req.body || {};

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
      return res.status(401).json({ valid: false, error: 'Wrong passcode.' });
    }

    let alreadySubmitted = false;
    if (deviceId && DEVICE_ID_PATTERN.test(deviceId)) {
      const { count } = await supabase
        .from('submissions')
        .select('id', { count: 'exact', head: true })
        .eq('quiz_id', quiz.id)
        .eq('device_id', deviceId);
      alreadySubmitted = (count ?? 0) > 0;
    }

    if (quiz.mode === 'sync') {
      if (!['waiting', 'active'].includes(quiz.status)) {
        return res.status(403).json({
          valid: false,
          error: 'This quiz session is not open yet. Wait for your instructor to start it, then try again.'
        });
      }
      await supabase.from('audit_log').insert({
        event_type: 'passcode_validated',
        ip_address: ip,
        event_data: { quiz_id: quiz.id, mode: 'sync', status: quiz.status }
      });
      return res.status(200).json({
        valid: true,
        mode: 'sync',
        status: quiz.status,
        quizId: quiz.id,
        quizTitle: quiz.title,
        courseName: quiz.courseName,
        alreadySubmitted
      });
    }

    const token = jwt.sign({ ip, quizId: quiz.id }, process.env.JWT_SECRET, { expiresIn: '6h' });
    await supabase.from('audit_log').insert({
      event_type: 'passcode_validated',
      ip_address: ip,
      event_data: { quiz_id: quiz.id, mode: 'password' }
    });

    return res.status(200).json({
      valid: true,
      mode: 'password',
      sessionToken: token,
      quizId: quiz.id,
      quizTitle: quiz.title,
      courseName: quiz.courseName,
      alreadySubmitted
    });
  } catch (e) {
    console.error('validate-password error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
