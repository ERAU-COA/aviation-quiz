-- Focus-loss policy: server-enforced termination of a quiz attempt.
-- Run once in Supabase SQL Editor (Dashboard -> SQL -> New query -> paste -> Run).
--
-- Idempotent and strictly ADDITIVE: it creates one new table and one new column.
-- It never drops, updates, or deletes any existing row.

-- 1. Per-quiz switch. Defaults to TRUE so every existing quiz is protected.
ALTER TABLE public.quizzes
  ADD COLUMN IF NOT EXISTS focus_policy_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- 2. Permanent record of every terminated attempt.
--    A terminated attempt is never deleted. If the instructor grants a retake the
--    row is soft-cleared (cleared_at is stamped) so the history survives.
CREATE TABLE IF NOT EXISTS public.attempt_terminations (
  id                  BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  quiz_id             BIGINT NOT NULL REFERENCES public.quizzes(id) ON DELETE CASCADE,
  device_id           TEXT NOT NULL,
  student_name        TEXT,
  reason              TEXT NOT NULL,
  detail              TEXT,
  event_type          TEXT,
  answered_count      INTEGER,
  questions_total     INTEGER,
  elapsed_seconds     INTEGER,
  ip_address          INET,
  user_agent          TEXT,
  browser_fingerprint TEXT,
  session_id          TEXT,
  terminated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleared_at          TIMESTAMPTZ,
  cleared_note        TEXT
);

-- One live block per device per quiz. Cleared rows are excluded so a student who
-- is allowed a retake and then leaves the page again gets a second, separate row.
CREATE UNIQUE INDEX IF NOT EXISTS attempt_terminations_active_device_uniq
  ON public.attempt_terminations (quiz_id, device_id)
  WHERE cleared_at IS NULL;

CREATE INDEX IF NOT EXISTS attempt_terminations_quiz_time_idx
  ON public.attempt_terminations (quiz_id, terminated_at DESC);

CREATE INDEX IF NOT EXISTS attempt_terminations_active_fingerprint_idx
  ON public.attempt_terminations (quiz_id, browser_fingerprint)
  WHERE cleared_at IS NULL;

-- 3. Same lockdown as every other table: service role only.
ALTER TABLE public.attempt_terminations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all ON public.attempt_terminations;
CREATE POLICY deny_all ON public.attempt_terminations
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

-- 4. Make PostgREST pick up the new table/column immediately.
NOTIFY pgrst, 'reload schema';

SELECT 'attempt_terminations ready. quizzes.focus_policy_enabled added.' AS status;
