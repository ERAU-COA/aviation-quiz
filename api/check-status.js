import {
  getSupabase,
  applyCors,
  findQuizById,
  findActiveTermination,
  terminationPayload,
  DEVICE_ID_PATTERN
} from './_lib.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const quizId = Number(req.query?.quizId);
  if (!Number.isFinite(quizId)) return res.status(400).json({ error: 'Missing quizId' });

  try {
    const supabase = getSupabase();
    const quiz = await findQuizById(supabase, quizId);
    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });

    const deviceId = req.query?.deviceId;
    const validDeviceId = deviceId && DEVICE_ID_PATTERN.test(deviceId) ? deviceId : null;

    let alreadySubmitted = false;
    if (validDeviceId) {
      const { count, error } = await supabase
        .from('submissions')
        .select('id', { count: 'exact', head: true })
        .eq('quiz_id', quizId)
        .eq('device_id', validDeviceId);
      if (error) throw error;
      alreadySubmitted = (count ?? 0) > 0;
    }

    const termination = validDeviceId
      ? await findActiveTermination(supabase, quizId, { deviceId: validDeviceId })
      : null;

    return res.status(200).json({
      alreadySubmitted,
      mode: quiz.mode,
      status: quiz.status,
      quizId: quiz.id,
      quizTitle: quiz.title,
      courseName: quiz.courseName,
      focusPolicyEnabled: quiz.focus_policy_enabled !== false,
      ...terminationPayload(termination)
    });
  } catch (e) {
    console.error('check-status error:', e);
    return res.status(500).json({ error: 'Internal server error', message: e.message });
  }
}
