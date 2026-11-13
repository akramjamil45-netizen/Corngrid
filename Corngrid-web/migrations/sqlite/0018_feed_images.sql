CREATE TABLE IF NOT EXISTS feed_image_uploads (
 image_path TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS feed_uploads_owner ON feed_image_uploads(user_id,created_at);
CREATE TABLE IF NOT EXISTS feed_post_images (
 post_id INTEGER NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
 display_order INTEGER NOT NULL CHECK(display_order BETWEEN 0 AND 4),
 image_path TEXT NOT NULL,
 PRIMARY KEY(post_id,display_order),
 UNIQUE(post_id,image_path)
);
