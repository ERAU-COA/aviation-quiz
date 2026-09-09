import jwt from 'jsonwebtoken';
import { getSupabase, applyCors, isMissingTerminationTable } from './_lib.js';

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

function getQuizId(req) {
  const id = Number(req.query?.quizId ?? req.query?.id);
  return Number.isFinite(id) ? id : null;
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (!requireInstructor(req, res)) return;

  const supabase = getSupabase();
  const action = req.query?.action;

  try {
    if (action === 'courses') {
      if (req.method === 'GET') {
        const { data, error } = await supabase
          .from('courses')
          .select('id, name, description, created_at')
          .order('name', { ascending: true });
        if (error) throw error;
        return res.status(200).json({ courses: data });
      }
      if (req.method === 'POST') {
        const { name, description } = req.body || {};
        if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Course name required' });
        const { data, error } = await supabase
          .from('courses')
          .insert({
            name: name.trim().slice(0, 200),
            description: typeof description === 'string' ? description.slice(0, 1000) : null
          })
          .select()
          .single();
        if (error) throw error;
        return res.status(200).json({ course: data });
      }
      if (req.method === 'PUT') {
        const id = Number(req.query?.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Missing course id' });
        const { name, description } = req.body || {};
        const update = {};
        if (typeof name === 'string' && name.trim()) update.name = name.trim().slice(0, 200);
        if (typeof description === 'string') update.description = description.slice(0, 1000);
        if (Object.keys(update).length === 0) return res.status(400).json({ error: 'No fields to update' });
        const { error } = await supabase.from('courses').update(update).eq('id', id);
        if (error) throw error;
        return res.status(200).json({ success: true });
      }
      if (req.method === 'DELETE') {
        const id = Number(req.query?.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Missing course id' });
        const { error } = await supabase.from('courses').delete().eq('id', id);
        if (error) throw error;
        return res.status(200).json({ success: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (action === 'quizzes') {
      if (req.method === 'GET') {
        const courseId = Number(req.query?.courseId);
        let q = supabase
          .from('quizzes')
          .select('id, title, course_id, week_number, session_number, password, mode, status')
          .order('week_number', { ascending: true, nullsFirst: false })
          .order('session_number', { ascending: true, nullsFirst: false })
          .order('id', { ascending: true });
        if (Number.isFinite(courseId)) q = q.eq('course_id', courseId);
        const { data, error } = await q;
        if (error) throw error;
        return res.status(200).json({ quizzes: data });
      }
      if (req.method === 'POST') {
        const { course_id, title, password, week_number, session_number, time_limit_minutes, timer_enabled, mode } = req.body || {};
        if (!Number.isFinite(Number(course_id))) return res.status(400).json({ error: 'course_id required' });
        if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title required' });
        if (typeof password !== 'string' || !password.trim()) return res.status(400).json({ error: 'password required' });
        const insert = {
          course_id: Number(course_id),
          title: title.trim().slice(0, 200),
          password: password.trim().slice(0, 100),
          week_number: Number.isFinite(Number(week_number)) ? Math.max(1, Math.floor(Number(week_number))) : 1,
          session_number: Number.isFinite(Number(session_number)) ? Math.max(1, Math.floor(Number(session_number))) : 1,
          time_limit_minutes: Number.isFinite(Number(time_limit_minutes)) ? Math.max(1, Math.floor(Number(time_limit_minutes))) : 5,
          timer_enabled: typeof timer_enabled === 'boolean' ? timer_enabled : true,
          mode: mode === 'sync' ? 'sync' : 'password',
          status: 'inactive'
        };
        const { data, error } = await supabase.from('quizzes').insert(insert).select().single();
        if (error) throw error;
        return res.status(200).json({ quiz: data });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (action === 'quiz') {
      const quizId = getQuizId(req);
      if (!quizId) return res.status(400).json({ error: 'Missing quizId' });
      if (req.method === 'GET') {
        const BASE = 'id, course_id, title, description, password, time_limit_minutes, timer_enabled, week_number, session_number, mode, status';
        let { data, error } = await supabase
          .from('quizzes')
          .select(`${BASE}, focus_policy_enabled`)
          .eq('id', quizId)
          .single();
        if (error && /focus_policy_enabled/.test(error.message || '')) {
          // focus-policy.sql has not been run yet - keep the portal usable.
          ({ data, error } = await supabase.from('quizzes').select(BASE).eq('id', quizId).single());
        }
        if (error) throw error;
        return res.status(200).json({ quiz: data });
      }
      if (req.method === 'PUT') {
        const { title, description, password, time_limit_minutes, timer_enabled, focus_policy_enabled, week_number, session_number, course_id, mode } = req.body || {};
        const update = {};
        if (typeof focus_policy_enabled === 'boolean') update.focus_policy_enabled = focus_policy_enabled;
        if (typeof title === 'string') update.title = title.slice(0, 200);
        if (typeof description === 'string') update.description = description.slice(0, 1000);
        if (typeof password === 'string' && password.length > 0) update.password = password.slice(0, 100);
        if (Number.isFinite(Number(time_limit_minutes))) update.time_limit_minutes = Math.max(1, Math.floor(Number(time_limit_minutes)));
        if (typeof timer_enabled === 'boolean') update.timer_enabled = timer_enabled;
        if (Number.isFinite(Number(week_number))) update.week_number = Math.max(1, Math.floor(Number(week_number)));
        if (Number.isFinite(Number(session_number))) update.session_number = Math.max(1, Math.floor(Number(session_number)));
        if (Number.isFinite(Number(course_id))) update.course_id = Number(course_id);
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
      if (req.method === 'DELETE') {
        const { error } = await supabase.from('quizzes').delete().eq('id', quizId);
        if (error) throw error;
        return res.status(200).json({ success: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (action === 'set-status') {
      if (req.method !== 'PUT') return res.status(405).json({ error: 'Method not allowed' });
      const quizId = getQuizId(req);
      if (!quizId) return res.status(400).json({ error: 'Missing quizId' });
      const { status } = req.body || {};
      if (!['inactive', 'waiting', 'active', 'ended'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      if (status === 'waiting' || status === 'active') {
        await supabase
          .from('quizzes')
          .update({ status: 'inactive' })
          .neq('id', quizId)
          .in('status', ['waiting', 'active']);
      }
      const { error } = await supabase.from('quizzes').update({ status }).eq('id', quizId);
      if (error) throw error;
      if (status === 'inactive') {
        await supabase.from('waiting_room').delete().eq('quiz_id', quizId);
      }
      return res.status(200).json({ success: true });
    }

    if (action === 'waiting-room') {
      const quizId = getQuizId(req);
      if (!quizId) return res.status(400).json({ error: 'Missing quizId' });
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
        const quizId = getQuizId(req);
        if (!quizId) return res.status(400).json({ error: 'Missing quizId' });
        const { data, error } = await supabase
          .from('questions')
          .select('id, question_number, question_text, option_a, option_b, option_c, option_d, correct_answer')
          .eq('quiz_id', quizId)
          .order('question_number', { ascending: true });
        if (error) throw error;
        return res.status(200).json({ questions: data });
      }
      if (req.method === 'POST') {
        const quizId = getQuizId(req);
        if (!quizId) return res.status(400).json({ error: 'Missing quizId' });
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
        const { error } = await supabase.from('questions').update(update).eq('id', id);
        if (error) throw error;
        return res.status(200).json({ success: true });
      }
      if (req.method === 'DELETE') {
        const id = Number(req.query?.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Missing question id' });
        const { error } = await supabase.from('questions').delete().eq('id', id);
        if (error) throw error;
        return res.status(200).json({ success: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (action === 'submissions') {
      if (req.method === 'GET') {
        const quizId = getQuizId(req);
        if (!quizId) return res.status(400).json({ error: 'Missing quizId' });
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
        const { error } = await supabase.from('submissions').delete().eq('id', id);
        if (error) throw error;
        return res.status(200).json({ success: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (action === 'terminations') {
      const quizId = getQuizId(req);
      if (!quizId) return res.status(400).json({ error: 'Missing quizId' });

      if (req.method === 'GET') {
        const { data, error } = await supabase
          .from('attempt_terminations')
          .select('id, student_name, device_id, reason, detail, event_type, answered_count, questions_total, elapsed_seconds, ip_address, user_agent, terminated_at, cleared_at, cleared_note')
          .eq('quiz_id', quizId)
          .order('terminated_at', { ascending: false });
        if (error) {
          if (isMissingTerminationTable(error)) {
            return res.status(200).json({ terminations: [], unavailable: true });
          }
          throw error;
        }
        return res.status(200).json({ terminations: data || [] });
      }

      // Terminations are never deleted. Granting a retake soft-clears the row so
      // the record of what happened survives.
      if (req.method === 'PUT') {
        const id = Number(req.query?.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Missing termination id' });
        const { cleared, note } = req.body || {};
        const update = cleared === false
          ? { cleared_at: null, cleared_note: null }
          : {
              cleared_at: new Date().toISOString(),
              cleared_note: typeof note === 'string' && note.trim()
                ? note.trim().slice(0, 300)
                : 'Retake allowed by instructor'
            };
        const { error } = await supabase
          .from('attempt_terminations')
          .update(update)
          .eq('id', id)
          .eq('quiz_id', quizId);
        if (error) {
          if (error.code === '23505') {
            return res.status(409).json({ error: 'A newer termination is already blocking this device.' });
          }
          throw error;
        }
        return res.status(200).json({ success: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (action === 'stats') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const quizId = getQuizId(req);
      if (!quizId) return res.status(400).json({ error: 'Missing quizId' });
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
      const subIds = (subs || []).map(s => s.id);
      let answers = [];
      if (subIds.length) {
        const { data, error: aErr } = await supabase
          .from('student_answers')
          .select('question_id, is_correct, student_answer')
          .in('submission_id', subIds);
        if (aErr) throw aErr;
        answers = data || [];
      }
      const perQuestion = questions.map(q => {
        const qAnswers = answers.filter(a => a.question_id === q.id);
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
