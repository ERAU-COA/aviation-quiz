-- Run this once in Supabase SQL Editor (Dashboard -> SQL -> New query -> paste -> Run).
-- Idempotent: safe to run multiple times.

-- 1. Audit log table for tracking quiz events.
CREATE TABLE IF NOT EXISTS public.audit_log (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  submission_id BIGINT REFERENCES public.submissions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  ip_address INET,
  event_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_log_event_ip_time_idx
  ON public.audit_log (event_type, ip_address, created_at DESC);

-- 2. Lock down every table. Service role bypasses RLS implicitly,
-- so only the Vercel backend (which uses the service key) can read/write.
ALTER TABLE public.quizzes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.questions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.submissions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log       ENABLE ROW LEVEL SECURITY;

-- 3. Drop any prior anon/auth policies, then add deny-by-default policies for safety.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT policyname, schemaname, tablename
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('quizzes', 'questions', 'submissions', 'student_answers', 'audit_log')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;

-- Explicit no-op policies for non-service roles. Service role bypasses RLS entirely.
CREATE POLICY deny_all ON public.quizzes         FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY deny_all ON public.questions       FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY deny_all ON public.submissions     FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY deny_all ON public.student_answers FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY deny_all ON public.audit_log       FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

SELECT 'RLS enabled. audit_log ready. Service role only.' AS status;
