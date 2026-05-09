import jwt from 'jsonwebtoken';
import { getSupabase, applyCors, getActiveQuizId } from './_lib.js';

function requireInstructor(req, res) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing token' });
    return null;
  }
  try {
    const decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    if (!decoded?.instructor) {
      res.status(403).json({ error: 'Not an instructor token' });
      return null;
    }
    return decoded;
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
    return null;
  }
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (!requireInstructor(req, res)) return;

  const supabase = getSupabase();
  const action = req.query?.action;

  try {
    const quizId = await getActiveQuizId(supabase);

    if (action === 'quiz') {
      if (req.method === 'GET') {
        const { data, error } = await supabase
          .from('quizzes')
          .select('id, title, description, password, time_limit_minutes, timer_enabled, week_number, mode, status')
          .eq('id', quizId)
          .single();
        if (error) throw error;
        return res.status(200).json({ quiz: data });
      }
      if (req.method === 'PUT') {
        const { title, description, password, time_limit_minutes, timer_enabled, mode } = req.body || {};
        const update = {};
        if (typeof title === 'string') update.title = title.slice(0, 200);
        if (typeof description === 'string') update.description = description.slice(0, 1000);
        if (typeof password === 'string' && password.length > 0) update.password = password.slice(0, 100);
        if (Number.isFinite(Number(time_limit_minutes))) update.time_limit_minutes = Math.max(1, Math.floor(Number(time_limit_minutes)));
        if (typeof timer_enabled === 'boolean') update.timer_enabled = timer_enabled;
        if (mode === 'password' || mode === 'sync') {
          update.mode = mode;
          if (mode === 'password') update.status = 'inactive';
        }
        if (Object.keys(update).length === 0) return res.status(400).json({ error: 'No fields to update' });
        const { error } = await supabase.from('quizzes').update(update).eq('id', quizId);
        if (error) throw error;
        if (mode === 'password') {
          await supabase.from('waiting_room').delete().eq('quiz_id', quizId);
        }
        return res.status(200).json({ success: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (action === 'set-status') {
      if (req.method !== 'PUT') return res.status(405).json({ error: 'Method not allowed' });
      const { status } = req.body || {};
      if (!['inactive', 'waiting', 'active', 'ended'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      const { error } = await supabase.from('quizzes').update({ status }).eq('id', quizId);
      if (error) throw error;
      if (status === 'inactive') {
        await supabase.from('waiting_room').delete().eq('quiz_id', quizId);
      }
      return res.status(200).json({ success: true });
    }

    if (action === 'waiting-room') {
      if (req.method === 'GET') {
        const { data, error } = await supabase
          .from('waiting_room')
          .select('id, student_name, device_id, joined_at')
          .eq('quiz_id', quizId)
          .order('joined_at', { ascending: true });
        if (error) throw error;
        return res.status(200).json({ students: data });
      }
      if (req.method === 'DELETE') {
        const { error } = await supabase.from('waiting_room').delete().eq('quiz_id', quizId);
        if (error) throw error;
        return res.status(200).json({ success: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (action === 'questions') {
      if (req.method === 'GET') {
        const { data, error } = await supabase
          .from('questions')
          .select('id, question_number, question_text, option_a, option_b, option_c, option_d, correct_answer')
          .eq('quiz_id', quizId)
          .order('question_number', { ascending: true });
        if (error) throw error;
        return res.status(200).json({ questions: data });
      }
      if (req.method === 'POST') {
        const q = req.body || {};
        if (!q.question_text || !q.option_a || !q.option_b || !q.option_c || !q.option_d || !['A','B','C','D'].includes(q.correct_answer)) {
          return res.status(400).json({ error: 'Missing or invalid fields' });
        }
        const { data: maxRow } = await supabase
          .from('questions')
          .select('question_number')
          .eq('quiz_id', quizId)
          .order('question_number', { ascending: false })
          .limit(1)
          .maybeSingle();
        const nextNumber = (maxRow?.question_number ?? 0) + 1;
        const { data, error } = await supabase
          .from('questions')
          .insert({
            quiz_id: quizId,
            question_number: q.question_number ?? nextNumber,
            question_text: String(q.question_text).slice(0, 1000),
            option_a: String(q.option_a).slice(0, 500),
            option_b: String(q.option_b).slice(0, 500),
            option_c: String(q.option_c).slice(0, 500),
            option_d: String(q.option_d).slice(0, 500),
            correct_answer: q.correct_answer
          })
          .select()
          .single();
        if (error) throw error;
        return res.status(200).json({ question: data });
      }
      if (req.method === 'PUT') {
        const id = Number(req.query?.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Missing question id' });
        const q = req.body || {};
        const update = {};
        if (typeof q.question_text === 'string') update.question_text = q.question_text.slice(0, 1000);
        if (typeof q.option_a === 'string') update.option_a = q.option_a.slice(0, 500);
        if (typeof q.option_b === 'string') update.option_b = q.option_b.slice(0, 500);
        if (typeof q.option_c === 'string') update.option_c = q.option_c.slice(0, 500);
        if (typeof q.option_d === 'string') update.option_d = q.option_d.slice(0, 500);
        if (['A','B','C','D'].includes(q.correct_answer)) update.correct_answer = q.correct_answer;
        if (Number.isFinite(Number(q.question_number))) update.question_number = Math.floor(Number(q.question_number));
        if (Object.keys(update).length === 0) return res.status(400).json({ error: 'No fields to update' });
        const { error } = await supabase.from('questions').update(update).eq('id', id).eq('quiz_id', quizId);
        if (error) throw error;
        return res.status(200).json({ success: true });
      }
      if (req.method === 'DELETE') {
        const id = Number(req.query?.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Missing question id' });
        const { error } = await supabase.from('questions').delete().eq('id', id).eq('quiz_id', quizId);
        if (error) throw error;
        return res.status(200).json({ success: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (action === 'submissions') {
      if (req.method === 'GET') {
        const { data: submissions, error } = await supabase
          .from('submissions')
          .select('id, student_name, score, total_questions, time_taken_seconds, submitted_at, ip_address, device_type, user_agent, browser_fingerprint')
          .eq('quiz_id', quizId)
          .order('submitted_at', { ascending: false });
        if (error) throw error;
        if (!submissions?.length) return res.status(200).json({ submissions: [] });
        const ids = submissions.map(s => s.id);
        const { data: answers, error: aErr } = await supabase
          .from('student_answers')
          .select('submission_id, question_id, student_answer, is_correct')
          .in('submission_id', ids);
        if (aErr) throw aErr;
        const grouped = {};
        for (const a of answers || []) {
          (grouped[a.submission_id] ||= []).push(a);
        }
        return res.status(200).json({
          submissions: submissions.map(s => ({ ...s, answers: grouped[s.id] || [] }))
        });
      }
      if (req.method === 'DELETE') {
        const id = Number(req.query?.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Missing submission id' });
        const { error } = await supabase.from('submissions').delete().eq('id', id).eq('quiz_id', quizId);
        if (error) throw error;
        return res.status(200).json({ success: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (action === 'stats') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const { data: questions, error: qErr } = await supabase
        .from('questions')
        .select('id, question_number, question_text, correct_answer')
        .eq('quiz_id', quizId)
        .order('question_number', { ascending: true });
      if (qErr) throw qErr;
      const { data: subs, error: sErr } = await supabase
        .from('submissions')
        .select('id, score, total_questions')
        .eq('quiz_id', quizId);
      if (sErr) throw sErr;
      const { data: answers, error: aErr } = await supabase
        .from('student_answers')
        .select('question_id, is_correct, student_answer')
        .in('submission_id', (subs || []).map(s => s.id));
      if (aErr) throw aErr;
      const perQuestion = questions.map(q => {
        const qAnswers = (answers || []).filter(a => a.question_id === q.id);
        const correct = qAnswers.filter(a => a.is_correct).length;
        const total = qAnswers.length;
        const counts = { A: 0, B: 0, C: 0, D: 0 };
        for (const a of qAnswers) {
          if (counts[a.student_answer] !== undefined) counts[a.student_answer]++;
        }
        return {
          id: q.id,
          number: q.question_number,
          text: q.question_text,
          correctAnswer: q.correct_answer,
          correct,
          total,
          percent: total ? Math.round((correct / total) * 100) : 0,
          choiceCounts: counts
        };
      });
      const totalSubs = (subs || []).length;
      const avgScore = totalSubs
        ? Math.round((subs.reduce((sum, s) => sum + (s.score || 0), 0) / totalSubs) * 10) / 10
        : 0;
      return res.status(200).json({
        totalSubmissions: totalSubs,
        averageScore: avgScore,
        totalQuestions: questions.length,
        perQuestion
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('instructor handler error:', e);
    return res.status(500).json({ error: 'Internal server error', message: e.message });
  }
}
