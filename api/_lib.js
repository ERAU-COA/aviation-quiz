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

export async function getActiveSyncQuiz(supabase) {
  const { data } = await supabase
    .from('quizzes')
    .select('id, title, mode, status, time_limit_minutes, timer_enabled, course_id, week_number, session_number')
    .eq('mode', 'sync')
    .in('status', ['waiting', 'active'])
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

export async function findQuizByPassword(supabase, password) {
  if (typeof password !== 'string' || !password) return null;
  const { data } = await supabase
    .from('quizzes')
    .select('id, title, mode, password, time_limit_minutes, timer_enabled, course_id, week_number, session_number')
    .eq('password', password)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}
