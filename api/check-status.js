import { getSupabase, applyCors, findQuizById } from './_lib.js';

const DEVICE_ID_PATTERN = /^[a-f0-9-]{8,64}$/i;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const quizId = Number(req.query?.quizId);
  if (!Number.isFinite(quizId)) return res.status(400).json({ error: 'Missing quizId' });

  try {
    const supabase = getSupabase();
    const quiz = await findQuizById(supabase, quizId);
    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });

    let alreadySubmitted = false;
    const deviceId = req.query?.deviceId;
    if (deviceId && DEVICE_ID_PATTERN.test(deviceId)) {
      const { count, error } = await supabase
        .from('submissions')
        .select('id', { count: 'exact', head: true })
        .eq('quiz_id', quizId)
        .eq('device_id', deviceId);
      if (error) throw error;
      alreadySubmitted = (count ?? 0) > 0;
    }

    return res.status(200).json({
      alreadySubmitted,
      mode: quiz.mode,
      status: quiz.status,
      quizId: quiz.id,
      quizTitle: quiz.title,
      courseName: quiz.courseName
    });
  } catch (e) {
    console.error('check-status error:', e);
    return res.status(500).json({ error: 'Internal server error', message: e.message });
  }
}
