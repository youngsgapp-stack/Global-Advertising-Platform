/**
 * PostgreSQL 데이터베이스 초기화
 * Supabase 또는 직접 Postgres 연결
 */

import pg from 'pg';
const { Pool } = pg;

let pool = null;

/**
 * DB 연결 풀 초기화
 */
export async function initDatabase() {
    if (pool) {
        return pool;
    }
    
    const connectionString = process.env.DATABASE_URL;
    
    // 디버깅: 환경 변수 상태 확인
    console.log('🔍 Checking DATABASE_URL...');
    console.log('   Type:', typeof connectionString);
    console.log('   Is undefined:', connectionString === undefined);
    console.log('   Is null:', connectionString === null);
    console.log('   Length:', connectionString ? connectionString.length : 'N/A');
    
    if (!connectionString) {
        console.error('❌ DATABASE_URL environment variable is missing');
        console.error('   Please set DATABASE_URL in Railway Variables');
        console.error('   All env vars:', Object.keys(process.env).filter(k => k.includes('DATABASE') || k.includes('POSTGRES')));
        throw new Error('DATABASE_URL environment variable is required');
    }
    
    if (typeof connectionString !== 'string') {
        console.error('❌ DATABASE_URL is not a string:', typeof connectionString);
        throw new Error('DATABASE_URL must be a string');
    }
    
    // 연결 문자열 앞부분만 표시 (보안)
    const preview = connectionString.substring(0, 30) + '...';
    console.log('   Preview:', preview);
    
    if (!connectionString.startsWith('postgresql://') && !connectionString.startsWith('postgres://')) {
        console.error('❌ DATABASE_URL must start with postgresql:// or postgres://');
        console.error('   Current value (first 50 chars):', connectionString.substring(0, 50));
        throw new Error('Invalid DATABASE_URL format');
    }
    
    // 연결 문자열 정리 (앞뒤 공백 제거)
    const cleanConnectionString = connectionString.trim();
    if (cleanConnectionString !== connectionString) {
        console.log('⚠️  DATABASE_URL had leading/trailing whitespace, trimmed');
    }
    
    pool = new Pool({
        connectionString: cleanConnectionString,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        max: 20, // 최대 연결 수
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000, // 연결 타임아웃 증가
    });
    
    // 연결 테스트
    try {
        const client = await pool.connect();
        const result = await client.query('SELECT NOW()');
        console.log('📦 Database connected:', result.rows[0].now);
        client.release();
    } catch (error) {
        console.error('❌ Database connection failed:', error);
        throw error;
    }
    
    return pool;
}

/**
 * DB 풀 가져오기
 */
export function getPool() {
    if (!pool) {
        throw new Error('Database not initialized. Call initDatabase() first.');
    }
    return pool;
}

/**
 * 쿼리 실행 헬퍼
 */
export async function query(text, params) {
    const pool = getPool();
    return await pool.query(text, params);
}

