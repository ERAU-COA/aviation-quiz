import jwt from 'jsonwebtoken';
import { getSupabase, getClientIp, applyCors, getActiveSyncQuiz } from './_lib.js';

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
    const quiz = await getActiveSyncQuiz(supabase);
    if (!quiz) {
      return res.status(403).json({ error: 'session_not_open', message: 'No synchronous session is open right now.' });
    }

    const cleanName = studentName.trim().slice(0, MAX_NAME_LENGTH);
    const ip = getClientIp(req);

    await supabase
      .from('waiting_room')
      .upsert(
        { quiz_id: quiz.id, student_name: cleanName, device_id: deviceId },
        { onConflict: 'quiz_id,device_id' }
      );

    const token = jwt.sign({ ip, quizId: quiz.id, sync: true }, process.env.JWT_SECRET, { expiresIn: '6h' });
    return res.status(200).json({ valid: true, sessionToken: token, status: quiz.status, quizTitle: quiz.title });
  } catch (e) {
    console.error('join-waiting-room error:', e);
    return res.status(500).json({ error: 'Internal server error', message: e.message });
  }
}
