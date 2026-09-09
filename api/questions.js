import jwt from 'jsonwebtoken';
import {
  getSupabase,
  getClientIp,
  applyCors,
  findQuizById,
  findActiveTermination,
  terminationPayload,
  DEVICE_ID_PATTERN
} from './_lib.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });

  let decoded;
  try {
    decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
  const quizId = decoded?.quizId;
  if (!quizId) return res.status(401).json({ error: 'Token missing quizId' });

  const supabase = getSupabase();
  const ip = getClientIp(req);

  // Prefer the device bound into the signed token; fall back to the query only
  // for sessions issued before the token carried one.
  const queryDeviceId = req.query?.deviceId;
  const deviceId = decoded?.deviceId
    || (queryDeviceId && DEVICE_ID_PATTERN.test(queryDeviceId) ? queryDeviceId : null);

  try {
    const quiz = await findQuizById(supabase, quizId);
    if (quiz?.mode === 'sync' && quiz?.status !== 'active') {
      return res.status(403).json({ error: 'session_not_active', message: 'The instructor has not started this quiz yet.' });
    }

    const termination = await findActiveTermination(supabase, quizId, { deviceId });
    if (termination) {
      return res.status(403).json({
        error: 'attempt_terminated',
        message: 'Your attempt at this quiz was terminated. Contact your instructor.',
        ...terminationPayload(termination)
      });
    }

    const { data: questions, error } = await supabase
      .from('questions')
      .select('id, question_text, option_a, option_b, option_c, option_d')
      .eq('quiz_id', quizId)
      .order('id', { ascending: true });
    if (error) throw error;

    await supabase.from('audit_log').insert({
      event_type: 'questions_retrieved',
      ip_address: ip,
      event_data: { count: questions.length, quiz_id: quizId }
    });

    return res.status(200).json({
      success: true,
      questions,
      totalQuestions: questions.length,
      quizTitle: quiz?.title,
      courseName: quiz?.courseName || null,
      timerEnabled: quiz?.timer_enabled !== false,
      timeLimitSeconds: Math.max(60, Math.floor((quiz?.time_limit_minutes ?? 5) * 60)),
      focusPolicyEnabled: quiz?.focus_policy_enabled !== false
    });
  } catch (e) {
    console.error('questions error:', e);
    return res.status(500).json({ error: 'Internal server error', message: e.message });
  }
}
