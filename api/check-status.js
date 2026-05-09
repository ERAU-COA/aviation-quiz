import { getSupabase, getClientIp, applyCors, computeDeviceFingerprint } from './_lib.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const supabase = getSupabase();
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] || '';
    const fingerprint = computeDeviceFingerprint(ip, ua);

    const { count, error } = await supabase
      .from('submissions')
      .select('id', { count: 'exact', head: true })
      .eq('device_fingerprint', fingerprint);
    if (error) throw error;

    return res.status(200).json({ alreadySubmitted: (count ?? 0) > 0 });
  } catch (e) {
    console.error('check-status error:', e);
    return res.status(500).json({ error: 'Internal server error', message: e.message });
  }
}
