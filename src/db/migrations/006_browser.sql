CREATE TABLE browser_sessions (
 id text PRIMARY KEY,
 user_id text NOT NULL,
 origin text NOT NULL,
 paths jsonb NOT NULL,
 selectors jsonb NOT NULL,
 profile_path text NOT NULL,
 mode text NOT NULL CHECK(mode IN ('LIVE','SANDBOX')),
 revision integer NOT NULL DEFAULT 0,
 expires_at timestamptz NOT NULL,
 disabled boolean NOT NULL DEFAULT false
);
