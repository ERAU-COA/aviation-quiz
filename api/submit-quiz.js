import jwt from 'jsonwebtoken';
import { getSupabase, getClientIp, applyCors, getActiveQuizId } from './_lib.js';

const MAX_NAME_LENGTH = 120;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { sessionToken, studentName, answers, timeTaken, deviceType, deviceId, browserFingerprint } = req.body || {};
  if (!sessionToken || !studentName || !answers || typeof answers !== 'object') {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!deviceId || !/^[a-f0-9-]{8,64}$/i.test(deviceId)) {
    return res.status(400).json({ error: 'Missing or invalid deviceId' });
  }
  const cleanFingerprint = typeof browserFingerprint === 'string' && /^[a-f0-9]{32,128}$/i.test(browserFingerprint)
    ? browserFingerprint
    : null;

  try {
    jwt.verify(sessionToken, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  const supabase = getSupabase();
  const ip = getClientIp(req);
  const userAgent = req.headers['user-agent'] || null;

  const cleanName = String(studentName).trim().slice(0, MAX_NAME_LENGTH);

  const { count: deviceMatch, error: dupeErr } = await supabase
    .from('submissions')
    .select('id', { count: 'exact', head: true })
    .eq('device_id', deviceId);
  if (dupeErr) {
    console.error('duplicate check error:', dupeErr);
    return res.status(500).json({ error: 'Internal server error' });
  }
  if ((deviceMatch ?? 0) > 0) {
    return res.status(409).json({ error: 'already_submitted', message: 'This device has already submitted this quiz.' });
  }

  if (cleanFingerprint) {
    const { count: fpNameMatch } = await supabase
      .from('submissions')
      .select('id', { count: 'exact', head: true })
      .eq('browser_fingerprint', cleanFingerprint)
      .ilike('student_name', cleanName);
    if ((fpNameMatch ?? 0) > 0) {
      return res.status(409).json({ error: 'already_submitted', message: 'A submission for this name has already been recorded from this browser.' });
    }
  }
  const cleanDevice = typeof deviceType === 'string' ? deviceType.slice(0, 20) : 'unknown';
  const cleanTime = Number.isFinite(Number(timeTaken)) ? Math.max(0, Math.floor(Number(timeTaken))) : 0;

  try {
    const quizId = await getActiveQuizId(supabase);
    const { data: questions, error: qErr } = await supabase
      .from('questions')
      .select('id, correct_answer')
      .eq('quiz_id', quizId);
    if (qErr) throw qErr;

    const results = questions.map(q => {
      const studentAnswer = answers[q.id] ?? null;
      return {
        questionId: q.id,
        studentAnswer,
        correctAnswer: q.correct_answer,
        isCorrect: studentAnswer === q.correct_answer
      };
    });
    const score = results.filter(r => r.isCorrect).length;

    const { data: submission, error: sErr } = await supabase
      .from('submissions')
      .insert({
        quiz_id: quizId,
        student_name: cleanName,
        score,
        total_questions: questions.length,
        time_taken_seconds: cleanTime,
        ip_address: ip,
        user_agent: userAgent,
        device_type: cleanDevice,
        device_id: deviceId,
        browser_fingerprint: cleanFingerprint
      })
      .select('id')
      .single();
    if (sErr || !submission) throw sErr || new Error('submission insert failed');

    const answerRows = results.map(r => ({
      submission_id: submission.id,
      question_id: r.questionId,
      student_answer: r.studentAnswer,
      is_correct: r.isCorrect
    }));
    const { error: aErr } = await supabase.from('student_answers').insert(answerRows);
    if (aErr) throw aErr;

    await supabase.from('audit_log').insert({
      submission_id: submission.id,
      event_type: 'quiz_submitted',
      ip_address: ip,
      event_data: {
        score,
        total_questions: questions.length,
        percentage: Math.round((score / questions.length) * 100),
        time_taken_seconds: cleanTime,
        device_type: cleanDevice
      }
    });

    return res.status(200).json({
      success: true,
      score,
      totalQuestions: questions.length,
      percentage: Math.round((score / questions.length) * 100),
      results,
      submissionId: submission.id
    });
  } catch (e) {
    console.error('submit-quiz error:', e);
    return res.status(500).json({ error: 'Internal server error', message: e.message });
  }
}
