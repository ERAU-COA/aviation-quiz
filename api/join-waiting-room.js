import jwt from 'jsonwebtoken';
import { getSupabase, getClientIp, applyCors, getActiveQuizId } from './_lib.js';

const DEVICE_ID_PATTERN = /^[a-f0-9-]{8,64}$/i;
const MAX_NAME_LENGTH = 120;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { studentName, deviceId } = req.body || {};
  if (!studentName || typeof studentName !== 'string') return res.status(400).json({ error: 'Missing student name' });
  if (!deviceId || !DEVICE_ID_PATTERN.test(deviceId)) return res.status(400).json({ error: 'Missing or invalid deviceId' });

  try {
    const supabase = getSupabase();
    const quizId = await getActiveQuizId(supabase);
    const { data: quiz } = await supabase.from('quizzes').select('mode, status').eq('id', quizId).single();
    if (quiz?.mode !== 'sync') return res.status(400).json({ error: 'Quiz is not in synchronous mode' });
    if (!['waiting', 'active'].includes(quiz?.status)) {
      return res.status(403).json({ error: 'session_not_open', message: 'The instructor has not opened the session yet.' });
    }

    const cleanName = studentName.trim().slice(0, MAX_NAME_LENGTH);
    const ip = getClientIp(req);

    await supabase
      .from('waiting_room')
      .upsert(
        { quiz_id: quizId, student_name: cleanName, device_id: deviceId },
        { onConflict: 'quiz_id,device_id' }
      );

    const token = jwt.sign({ ip, sync: true }, process.env.JWT_SECRET, { expiresIn: '6h' });
    return res.status(200).json({ valid: true, sessionToken: token, status: quiz.status });
  } catch (e) {
    console.error('join-waiting-room error:', e);
    return res.status(500).json({ error: 'Internal server error', message: e.message });
  }
}
