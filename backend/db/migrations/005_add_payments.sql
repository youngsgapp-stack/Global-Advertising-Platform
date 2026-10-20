-- PayPal 결제 시도 기록 (관리자 결제 내역 / 결제됐는데 포인트 미지급 건 추적)
CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    order_id VARCHAR(64) UNIQUE NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    provider VARCHAR(20) NOT NULL DEFAULT 'paypal',
    amount_usd DECIMAL(10,2),
    currency VARCHAR(8),
    points INTEGER,
    status VARCHAR(20) NOT NULL,
    capture_id VARCHAR(64),
    payer_id VARCHAR(64),
    error TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
