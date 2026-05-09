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

export async function getActiveQuizId(supabase) {
  if (process.env.QUIZ_ID) return Number(process.env.QUIZ_ID);
  const { data, error } = await supabase
    .from('quizzes')
    .select('id')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (error || !data) throw new Error('No quiz found. Set QUIZ_ID env var or seed a quiz row.');
  return data.id;
}
