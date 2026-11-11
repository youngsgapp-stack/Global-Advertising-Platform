-- Visitor feedback from the "Send Feedback" form (read in the admin page)
CREATE TABLE IF NOT EXISTS feedback (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    type VARCHAR(20) NOT NULL DEFAULT 'general',
    title VARCHAR(120) NOT NULL,
    message TEXT NOT NULL,
    rating SMALLINT,
    page_url VARCHAR(300),
    user_agent VARCHAR(300),
    status VARCHAR(20) NOT NULL DEFAULT 'new',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at DESC);
