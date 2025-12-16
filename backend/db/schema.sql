-- WorldAd Database Schema
-- PostgreSQL 12+

-- 사용자 테이블
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid VARCHAR(255) UNIQUE NOT NULL,
  email VARCHAR(255),
  nickname VARCHAR(255),
  avatar_url TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_users_firebase_uid ON users(firebase_uid);
CREATE INDEX idx_users_email ON users(email);

-- 영토 테이블
CREATE TABLE IF NOT EXISTS territories (
  id VARCHAR(255) PRIMARY KEY,
  code VARCHAR(255),
  name VARCHAR(255),
  name_en VARCHAR(255),
  country VARCHAR(100),
  continent VARCHAR(50),
  polygon JSONB, -- GeoJSON 폴리곤 데이터
  base_price DECIMAL(10, 2),
  status VARCHAR(50) DEFAULT 'unconquered', -- 'unconquered', 'contested', 'ruled'
  ruler_id UUID REFERENCES users(id),
  ruler_name VARCHAR(255),
  sovereignty VARCHAR(50),
  protection_ends_at TIMESTAMP,
  purchased_by_admin BOOLEAN DEFAULT FALSE,
  current_auction_id UUID, -- auctions 테이블 참조 (nullable)
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_territories_country ON territories(country);
CREATE INDEX idx_territories_status ON territories(status);
CREATE INDEX idx_territories_ruler_id ON territories(ruler_id);
CREATE INDEX idx_territories_updated_at ON territories(updated_at);

-- 경매 테이블
CREATE TABLE IF NOT EXISTS auctions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  territory_id VARCHAR(255) REFERENCES territories(id),
  status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'active', 'ended', 'cancelled'
  start_time TIMESTAMP,
  end_time TIMESTAMP,
  min_bid DECIMAL(10, 2),
  current_bid DECIMAL(10, 2),
  current_bidder_id UUID REFERENCES users(id),
  season INTEGER,
  country VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_auctions_territory_id ON auctions(territory_id);
CREATE INDEX idx_auctions_status ON auctions(status);
CREATE INDEX idx_auctions_season ON auctions(season);
CREATE INDEX idx_auctions_country ON auctions(country);
CREATE INDEX idx_auctions_end_time ON auctions(end_time);

-- 입찰 테이블
CREATE TABLE IF NOT EXISTS bids (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id UUID REFERENCES auctions(id),
  user_id UUID REFERENCES users(id),
  amount DECIMAL(10, 2) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_bids_auction_id ON bids(auction_id);
CREATE INDEX idx_bids_user_id ON bids(user_id);
CREATE INDEX idx_bids_created_at ON bids(created_at DESC);

-- 소유권 이력 테이블
CREATE TABLE IF NOT EXISTS ownerships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  territory_id VARCHAR(255) REFERENCES territories(id),
  user_id UUID REFERENCES users(id),
  acquired_at TIMESTAMP DEFAULT NOW(),
  price DECIMAL(10, 2),
  ended_at TIMESTAMP, -- 소유권이 끝난 시간 (null이면 현재 소유 중)
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_ownerships_territory_id ON ownerships(territory_id);
CREATE INDEX idx_ownerships_user_id ON ownerships(user_id);
CREATE INDEX idx_ownerships_acquired_at ON ownerships(acquired_at DESC);

-- 지갑 테이블
CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) UNIQUE NOT NULL,
  balance DECIMAL(10, 2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_wallets_user_id ON wallets(user_id);

-- 지갑 거래 이력 테이블
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID REFERENCES wallets(id),
  user_id UUID REFERENCES users(id),
  type VARCHAR(50), -- 'deposit', 'withdrawal', 'purchase', 'refund', 'reward'
  amount DECIMAL(10, 2),
  description TEXT,
  reference_id VARCHAR(255), -- 관련 거래 ID (auction, payment 등)
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_wallet_transactions_wallet_id ON wallet_transactions(wallet_id);
CREATE INDEX idx_wallet_transactions_user_id ON wallet_transactions(user_id);
CREATE INDEX idx_wallet_transactions_created_at ON wallet_transactions(created_at DESC);

-- updated_at 자동 업데이트 트리거 함수
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- updated_at 트리거 설정
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_territories_updated_at BEFORE UPDATE ON territories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_auctions_updated_at BEFORE UPDATE ON auctions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_wallets_updated_at BEFORE UPDATE ON wallets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 관리자 로그 테이블
CREATE TABLE IF NOT EXISTS admin_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action VARCHAR(100) NOT NULL,
  details JSONB,
  admin_email VARCHAR(255),
  admin_uid VARCHAR(255),
  user_agent TEXT,
  ip_address VARCHAR(45),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_admin_logs_action ON admin_logs(action);
CREATE INDEX idx_admin_logs_admin_email ON admin_logs(admin_email);
CREATE INDEX idx_admin_logs_created_at ON admin_logs(created_at DESC);

-- 영토 History 테이블 (감사로그 - 전문가 조언 반영)
-- append-only 불변 로그로 모든 영토 관련 이벤트 기록
CREATE TABLE IF NOT EXISTS territory_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  territory_id VARCHAR(255) REFERENCES territories(id) NOT NULL,
  user_id UUID REFERENCES users(id),
  event_type VARCHAR(50) NOT NULL, -- 'purchase', 'ownership_change', 'pixel_save', 'protection_expired', etc.
  metadata JSONB, -- 이벤트 상세 정보 (가격, 이전 소유자, 보호 기간 등)
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_territory_history_territory_id ON territory_history(territory_id);
CREATE INDEX idx_territory_history_user_id ON territory_history(user_id);
CREATE INDEX idx_territory_history_event_type ON territory_history(event_type);
CREATE INDEX idx_territory_history_created_at ON territory_history(created_at DESC);

-- 거래 내역 테이블 (wallet_transactions와 별도로 구매/입찰 거래 기록)
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) NOT NULL,
  type VARCHAR(50) NOT NULL, -- 'purchase', 'bid', 'bid_refund', 'charge', 'reward', 'admin'
  amount DECIMAL(10, 2) NOT NULL,
  balance_after DECIMAL(10, 2) NOT NULL,
  description TEXT,
  reference_id VARCHAR(255), -- 관련 ID (territory_id, auction_id 등)
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_transactions_user_id ON transactions(user_id);
CREATE INDEX idx_transactions_type ON transactions(type);
CREATE INDEX idx_transactions_reference_id ON transactions(reference_id);
CREATE INDEX idx_transactions_created_at ON transactions(created_at DESC);

