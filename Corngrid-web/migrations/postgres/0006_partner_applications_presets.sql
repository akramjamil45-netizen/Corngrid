BEGIN;

CREATE TABLE IF NOT EXISTS partner_applications (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 display_name TEXT NOT NULL, company TEXT, website TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 review_notes TEXT, reviewed_by TEXT, reviewed_at BIGINT,
 created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS ea_submission_presets (
 submission_id INTEGER NOT NULL REFERENCES ea_submissions(id) ON DELETE CASCADE,
 symbol TEXT NOT NULL, file_name TEXT NOT NULL, content_text TEXT NOT NULL,
 PRIMARY KEY(submission_id,symbol)
);

COMMIT;
