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
    
    if (!connectionString) {
        throw new Error('DATABASE_URL environment variable is required');
    }
    
    pool = new Pool({
        connectionString,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        max: 20, // 최대 연결 수
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
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

