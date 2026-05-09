import { getSupabase, applyCors } from './_lib.js';

const DEVICE_ID_PATTERN = /^[a-f0-9-]{8,64}$/i;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const deviceId = req.query?.deviceId;
  if (!deviceId || !DEVICE_ID_PATTERN.test(deviceId)) {
    return res.status(200).json({ alreadySubmitted: false });
  }

  try {
    const supabase = getSupabase();
    const { count, error } = await supabase
      .from('submissions')
      .select('id', { count: 'exact', head: true })
      .eq('device_id', deviceId);
    if (error) throw error;

    return res.status(200).json({ alreadySubmitted: (count ?? 0) > 0 });
  } catch (e) {
    console.error('check-status error:', e);
    return res.status(500).json({ error: 'Internal server error', message: e.message });
  }
}
