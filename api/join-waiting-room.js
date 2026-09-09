import { randomUUID } from 'crypto';
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

const MAX_NAME_LENGTH = 120;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { studentName, deviceId, quizId, browserFingerprint } = req.body || {};
  if (!studentName || typeof studentName !== 'string') return res.status(400).json({ error: 'Missing student name' });
  if (!deviceId || !DEVICE_ID_PATTERN.test(deviceId)) return res.status(400).json({ error: 'Missing or invalid deviceId' });
  if (!Number.isFinite(Number(quizId))) return res.status(400).json({ error: 'Missing quizId' });

  try {
    const supabase = getSupabase();
    const quiz = await findQuizById(supabase, Number(quizId));
    if (!quiz) {
      return res.status(404).json({ error: 'Quiz not found' });
    }
    if (quiz.mode !== 'sync') {
      return res.status(400).json({ error: 'This quiz is not in synchronous mode.' });
    }
    if (!['waiting', 'active'].includes(quiz.status)) {
      return res.status(403).json({
        error: 'session_not_open',
        message: 'This quiz session is not open. Wait for your instructor.'
      });
    }

    const { count: submitted } = await supabase
      .from('submissions')
      .select('id', { count: 'exact', head: true })
      .eq('quiz_id', quiz.id)
      .eq('device_id', deviceId);
    if ((submitted ?? 0) > 0) {
      return res.status(409).json({ error: 'already_submitted', message: 'You have already submitted this quiz.' });
    }

    const cleanName = studentName.trim().slice(0, MAX_NAME_LENGTH);
    const cleanFingerprint = typeof browserFingerprint === 'string' && /^[a-f0-9]{32,128}$/i.test(browserFingerprint)
      ? browserFingerprint
      : null;

    const termination = await findActiveTermination(supabase, quiz.id, {
      deviceId,
      browserFingerprint: cleanFingerprint,
      studentName: cleanName
    });
    if (termination) {
      return res.status(403).json({
        error: 'attempt_terminated',
        message: 'Your attempt at this quiz was terminated. Contact your instructor.',
        ...terminationPayload(termination)
      });
    }

    const ip = getClientIp(req);

    await supabase
      .from('waiting_room')
      .upsert(
        { quiz_id: quiz.id, student_name: cleanName, device_id: deviceId },
        { onConflict: 'quiz_id,device_id' }
      );

    const token = jwt.sign(
      { ip, quizId: quiz.id, sync: true, deviceId, sid: randomUUID() },
      process.env.JWT_SECRET,
      { expiresIn: '6h' }
    );
    return res.status(200).json({
      valid: true,
      sessionToken: token,
      status: quiz.status,
      quizTitle: quiz.title,
      courseName: quiz.courseName,
      focusPolicyEnabled: quiz.focus_policy_enabled !== false
    });
  } catch (e) {
    console.error('join-waiting-room error:', e);
    return res.status(500).json({ error: 'Internal server error', message: e.message });
  }
}
