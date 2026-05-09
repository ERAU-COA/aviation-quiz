import { getSupabase, applyCors, getActiveSyncQuiz } from './_lib.js';

const DEVICE_ID_PATTERN = /^[a-f0-9-]{8,64}$/i;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const supabase = getSupabase();
    const syncQuiz = await getActiveSyncQuiz(supabase);

    let alreadySubmitted = false;
    const deviceId = req.query?.deviceId;
    if (syncQuiz && deviceId && DEVICE_ID_PATTERN.test(deviceId)) {
      const { count, error } = await supabase
        .from('submissions')
        .select('id', { count: 'exact', head: true })
        .eq('device_id', deviceId)
        .eq('quiz_id', syncQuiz.id);
      if (error) throw error;
      alreadySubmitted = (count ?? 0) > 0;
    }

    if (syncQuiz) {
      return res.status(200).json({
        alreadySubmitted,
        mode: 'sync',
        status: syncQuiz.status,
        quizId: syncQuiz.id,
        quizTitle: syncQuiz.title
      });
    }
    return res.status(200).json({
      alreadySubmitted: false,
      mode: 'password',
      status: 'inactive'
    });
  } catch (e) {
    console.error('check-status error:', e);
    return res.status(500).json({ error: 'Internal server error', message: e.message });
  }
}
