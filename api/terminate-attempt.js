import jwt from 'jsonwebtoken';
import {
  getSupabase,
  getClientIp,
  applyCors,
  readJsonBody,
  findQuizById,
  findActiveTermination,
  isMissingTerminationTable,
  normalizeTerminationReason,
  describeTermination,
  terminationPayload,
  TERMINATION_EVENTS,
  DEVICE_ID_PATTERN
} from './_lib.js';

const MAX_NAME_LENGTH = 120;

function toInt(value, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(0, Math.floor(n)));
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = await readJsonBody(req);
  const { sessionToken, deviceId, studentName, reason, eventType, browserFingerprint } = body;

  let decoded;
  try {
    decoded = jwt.verify(String(sessionToken || ''), process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  const quizId = decoded?.quizId;
  if (!quizId) return res.status(401).json({ error: 'Token missing quizId' });

  // The device is taken from the signed token whenever it is present, so a
  // student can only ever end their own attempt.
  const effectiveDeviceId = decoded?.deviceId || deviceId;
  if (!effectiveDeviceId || !DEVICE_ID_PATTERN.test(effectiveDeviceId)) {
    return res.status(400).json({ error: 'Missing or invalid deviceId' });
  }
  if (decoded?.deviceId && deviceId && decoded.deviceId !== deviceId) {
    return res.status(401).json({ error: 'Session does not match this device' });
  }

  const supabase = getSupabase();
  const ip = getClientIp(req);
  const cleanReason = normalizeTerminationReason(reason);
  const detail = describeTermination(cleanReason);
  const cleanEvent = TERMINATION_EVENTS.includes(eventType) ? eventType : null;
  const cleanName = typeof studentName === 'string' && studentName.trim()
    ? studentName.trim().slice(0, MAX_NAME_LENGTH)
    : null;
  const cleanFingerprint = typeof browserFingerprint === 'string' && /^[a-f0-9]{32,128}$/i.test(browserFingerprint)
    ? browserFingerprint
    : null;

  try {
    const quiz = await findQuizById(supabase, quizId);
    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });

    // Instructor switched the policy off for this quiz - record nothing.
    if (quiz.focus_policy_enabled === false) {
      return res.status(200).json({ terminated: false, policyEnabled: false });
    }

    const existing = await findActiveTermination(supabase, quizId, { deviceId: effectiveDeviceId });
    if (existing) {
      return res.status(200).json(terminationPayload(existing));
    }

    const row = {
      quiz_id: quizId,
      device_id: effectiveDeviceId,
      student_name: cleanName,
      reason: cleanReason,
      detail,
      event_type: cleanEvent,
      answered_count: toInt(body.answeredCount, 10000),
      questions_total: toInt(body.questionsTotal, 10000),
      elapsed_seconds: toInt(body.elapsedSeconds, 86400),
      ip_address: ip,
      user_agent: req.headers['user-agent'] || null,
      browser_fingerprint: cleanFingerprint,
      session_id: decoded?.sid || null
    };

    const { data: inserted, error } = await supabase
      .from('attempt_terminations')
      .insert(row)
      .select('id, reason, detail, terminated_at')
      .single();

    if (error) {
      // 23505: another beacon from the same page won the race. Same outcome.
      if (error.code === '23505') {
        const dupe = await findActiveTermination(supabase, quizId, { deviceId: effectiveDeviceId });
        return res.status(200).json(terminationPayload(dupe) );
      }
      if (isMissingTerminationTable(error)) {
        console.error('attempt_terminations missing - run supabase/focus-policy.sql');
        return res.status(503).json({ error: 'termination_store_unavailable' });
      }
      throw error;
    }

    await supabase.from('audit_log').insert({
      event_type: 'attempt_terminated',
      ip_address: ip,
      event_data: {
        quiz_id: quizId,
        termination_id: inserted?.id ?? null,
        reason: cleanReason,
        event_type: cleanEvent,
        student_name: cleanName,
        answered_count: row.answered_count,
        questions_total: row.questions_total,
        elapsed_seconds: row.elapsed_seconds
      }
    });

    return res.status(200).json({
      terminated: true,
      terminationReason: cleanReason,
      terminationDetail: detail,
      terminatedAt: inserted?.terminated_at || new Date().toISOString()
    });
  } catch (e) {
    console.error('terminate-attempt error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
