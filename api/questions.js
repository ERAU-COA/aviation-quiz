import jwt from 'jsonwebtoken';
import { getSupabase, getClientIp, applyCors } from './_lib.js';

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

  try {
    const { data: quiz } = await supabase
      .from('quizzes')
      .select('time_limit_minutes, timer_enabled, title, courses(name)')
      .eq('id', quizId)
      .single();
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
      courseName: quiz?.courses?.name || null,
      timerEnabled: quiz?.timer_enabled !== false,
      timeLimitSeconds: Math.max(60, Math.floor((quiz?.time_limit_minutes ?? 5) * 60))
    });
  } catch (e) {
    console.error('questions error:', e);
    return res.status(500).json({ error: 'Internal server error', message: e.message });
  }
}
