-- Historical migration file retained for database history.
-- It removes the old provider-session table; Supabase Auth is the current identity provider.
DROP TABLE IF EXISTS user_sessions CASCADE;
