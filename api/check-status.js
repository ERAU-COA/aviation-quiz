import { getSupabase, applyCors, getActiveQuizId } from './_lib.js';

const DEVICE_ID_PATTERN = /^[a-f0-9-]{8,64}$/i;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const supabase = getSupabase();
    const quizId = await getActiveQuizId(supabase);
    const { data: quiz } = await supabase.from('quizzes').select('mode, status').eq('id', quizId).single();
    const mode = quiz?.mode || 'password';
    const status = quiz?.status || 'inactive';

    const deviceId = req.query?.deviceId;
    let alreadySubmitted = false;
    if (deviceId && DEVICE_ID_PATTERN.test(deviceId)) {
      const { count, error } = await supabase
        .from('submissions')
        .select('id', { count: 'exact', head: true })
        .eq('device_id', deviceId);
      if (error) throw error;
      alreadySubmitted = (count ?? 0) > 0;
    }

    return res.status(200).json({ alreadySubmitted, mode, status });
  } catch (e) {
    console.error('check-status error:', e);
    return res.status(500).json({ error: 'Internal server error', message: e.message });
  }
}
