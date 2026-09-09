import { createClient } from '@supabase/supabase-js';

let _client = null;
export function getSupabase() {
  if (!_client) {
    _client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false }
    });
  }
  return _client;
}

export function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || null;
}

export function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

export const DEVICE_ID_PATTERN = /^[a-f0-9-]{8,64}$/i;

const QUIZ_FIELDS_FULL = 'id, title, mode, status, password, time_limit_minutes, timer_enabled, focus_policy_enabled, course_id, week_number, session_number, courses(name)';
const QUIZ_FIELDS_BASE = 'id, title, mode, status, password, time_limit_minutes, timer_enabled, course_id, week_number, session_number, courses(name)';

// Degrades once, permanently, if focus-policy.sql has not been run yet, so a
// missing column can never take the quiz down.
let quizFields = QUIZ_FIELDS_FULL;

async function runQuizQuery(build) {
  let { data, error } = await build(quizFields);
  if (error && quizFields === QUIZ_FIELDS_FULL && /focus_policy_enabled/.test(error.message || '')) {
    console.warn('quizzes.focus_policy_enabled missing - run supabase/focus-policy.sql');
    quizFields = QUIZ_FIELDS_BASE;
    ({ data, error } = await build(quizFields));
  }
  if (error) {
    console.error('quiz lookup error:', error.message);
    return null;
  }
  return data;
}

function withCourseName(quiz) {
  if (!quiz) return null;
  return {
    ...quiz,
    focus_policy_enabled: quiz.focus_policy_enabled !== false,
    courseName: quiz.courses?.name || null
  };
}

export async function findQuizByPassword(supabase, password) {
  if (typeof password !== 'string' || !password) return null;
  const data = await runQuizQuery(fields => supabase
    .from('quizzes')
    .select(fields)
    .eq('password', password)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle());
  return withCourseName(data);
}

export async function findQuizById(supabase, id) {
  const data = await runQuizQuery(fields => supabase
    .from('quizzes')
    .select(fields)
    .eq('id', id)
    .maybeSingle());
  return withCourseName(data);
}

/* ---------------------------------------------------------------------------
 * Focus-loss policy
 * ------------------------------------------------------------------------- */

// The client only ever sends a reason code. The wording below is written on the
// server so a student cannot post arbitrary text into the instructor's report.
export const TERMINATION_REASONS = {
  tab_hidden: 'Left the quiz page - the tab was switched, the browser was minimised, another app was opened, or the screen was locked.',
  window_blur: 'The quiz window lost focus - another window or application was activated.',
  page_exit: 'The quiz page was closed, refreshed, or navigated away from.',
  split_view: 'The quiz window was resized or placed in split-screen / multitasking mode (for example iPad Split View or Slide Over), so another app was on screen beside the quiz.',
  unknown: 'The quiz page lost visibility or focus.'
};

export const TERMINATION_EVENTS = ['visibilitychange', 'blur', 'pagehide', 'beforeunload', 'freeze', 'resize', 'manual'];

export function normalizeTerminationReason(reason) {
  return Object.prototype.hasOwnProperty.call(TERMINATION_REASONS, reason) && reason !== 'unknown'
    ? reason
    : 'unknown';
}

export function describeTermination(reason) {
  return TERMINATION_REASONS[reason] || TERMINATION_REASONS.unknown;
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, m => `\\${m}`);
}

const TERMINATION_FIELDS = 'id, quiz_id, device_id, student_name, reason, detail, event_type, terminated_at, cleared_at';

export function isMissingTerminationTable(error) {
  if (!error) return false;
  const code = error.code || '';
  const msg = error.message || '';
  if (code === '42P01' || code === 'PGRST205') return true;
  return /attempt_terminations/.test(msg) && /does not exist|schema cache/i.test(msg);
}

/**
 * Returns the live (not cleared) termination that blocks this attempt, or null.
 * Matches on device id first, then on the same browser plus the same student
 * name - the same pair the duplicate-submission check already uses, so clearing
 * localStorage alone does not buy a second attempt.
 * Fails open: if the table is unreachable the quiz keeps working.
 */
export async function findActiveTermination(supabase, quizId, opts = {}) {
  const id = Number(quizId);
  if (!Number.isFinite(id)) return null;
  const { deviceId, browserFingerprint, studentName } = opts;
  try {
    if (deviceId && DEVICE_ID_PATTERN.test(deviceId)) {
      const { data, error } = await supabase
        .from('attempt_terminations')
        .select(TERMINATION_FIELDS)
        .eq('quiz_id', id)
        .eq('device_id', deviceId)
        .is('cleared_at', null)
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (data) return data;
    }
    if (browserFingerprint && studentName) {
      const { data, error } = await supabase
        .from('attempt_terminations')
        .select(TERMINATION_FIELDS)
        .eq('quiz_id', id)
        .eq('browser_fingerprint', browserFingerprint)
        .ilike('student_name', escapeLike(String(studentName).trim()))
        .is('cleared_at', null)
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (data) return data;
    }
  } catch (e) {
    if (isMissingTerminationTable(e)) {
      console.warn('attempt_terminations missing - run supabase/focus-policy.sql');
    } else {
      console.error('findActiveTermination error:', e.message || e);
    }
    return null;
  }
  return null;
}

export function terminationPayload(t) {
  if (!t) return { terminated: false };
  return {
    terminated: true,
    terminationReason: t.reason,
    terminationDetail: t.detail || describeTermination(t.reason),
    terminatedAt: t.terminated_at
  };
}

/**
 * navigator.sendBeacon has to use text/plain (the only cross-origin content type
 * that never needs a preflight), so the body can arrive as a raw string instead
 * of the object Vercel parses for application/json.
 */
export async function readJsonBody(req) {
  const body = req.body;
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body;

  let raw = null;
  if (typeof body === 'string') raw = body;
  else if (Buffer.isBuffer(body)) raw = body.toString('utf8');
  else {
    raw = await new Promise(resolve => {
      let acc = '';
      const timer = setTimeout(() => resolve(''), 2000);
      const done = value => { clearTimeout(timer); resolve(value); };
      req.on('data', chunk => { if (acc.length < 32768) acc += chunk; });
      req.on('end', () => done(acc));
      req.on('error', () => done(''));
    });
  }

  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
