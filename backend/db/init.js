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
    
    // 환경 변수 로드 확인
    console.log('🔍 [DB Init] Starting database initialization...');
    console.log('   NODE_ENV:', process.env.NODE_ENV);
    
    const connectionString = process.env.DATABASE_URL;
    
    // 디버깅: 환경 변수 상태 확인
    console.log('🔍 [DB Init] Checking DATABASE_URL...');
    console.log('   Type:', typeof connectionString);
    console.log('   Is undefined:', connectionString === undefined);
    console.log('   Is null:', connectionString === null);
    console.log('   Is empty string:', connectionString === '');
    console.log('   Length:', connectionString ? connectionString.length : 'N/A');
    
    // 관련 환경 변수 확인
    const dbRelatedVars = Object.keys(process.env).filter(k => 
        k.includes('DATABASE') || k.includes('POSTGRES') || k.includes('DB')
    );
    console.log('   Related env vars found:', dbRelatedVars.length > 0 ? dbRelatedVars : 'NONE');
    
    // ==========================================
    // 4단계: 애플리케이션 레벨 검증 (라이브러리 에러 방지)
    // ==========================================
    if (!connectionString) {
        console.error('❌ [DB Init] ========================================');
        console.error('❌ [DB Init] DATABASE_URL이 설정되지 않았습니다!');
        console.error('❌ [DB Init] ========================================');
        console.error('');
        console.error('해결 방법:');
        console.error('1. Railway 대시보드로 이동');
        console.error('2. 서비스 선택 → "Variables" 탭 클릭');
        console.error('3. "DATABASE_URL" 변수 추가');
        console.error('4. Supabase 연결 문자열 입력');
        console.error('   형식: postgresql://postgres:비밀번호@호스트:5432/postgres');
        console.error('');
        console.error('⚠️  서버를 시작할 수 없습니다.');
        console.error('❌ [DB Init] ========================================');
        throw new Error('DATABASE_URL environment variable is required. Please set it in Railway Variables.');
    }
    
    if (typeof connectionString !== 'string') {
        console.error('❌ [DB Init] DATABASE_URL is not a string:', typeof connectionString);
        throw new Error('DATABASE_URL must be a string');
    }
    
    if (connectionString.trim().length === 0) {
        console.error('❌ [DB Init] DATABASE_URL is empty after trimming');
        throw new Error('DATABASE_URL cannot be empty');
    }
    
    // 연결 문자열 정리 (앞뒤 공백 제거)
    let cleanConnectionString = connectionString.trim();
    if (cleanConnectionString !== connectionString) {
        console.log('⚠️  [DB Init] DATABASE_URL had leading/trailing whitespace, trimmed');
    }
    
    // 연결 문자열 앞부분만 표시 (보안)
    const preview = cleanConnectionString.replace(/^(postgres(?:ql)?:\/\/[^:]+:)[^@]*@/, '$1***@').replace(/@([^/:?]+).*/, '@$1/...');
    console.log('   Preview:', preview);
    
    if (!cleanConnectionString.startsWith('postgresql://') && !cleanConnectionString.startsWith('postgres://')) {
        console.error('❌ [DB Init] DATABASE_URL must start with postgresql:// or postgres://');
        console.error('   Current value starts with:', cleanConnectionString.substring(0, 12));
        throw new Error('Invalid DATABASE_URL format - must start with postgresql:// or postgres://');
    }
    
    // ==========================================
    // 🔧 비밀번호에 특수문자가 있는 경우 URL 인코딩 처리
    // ==========================================
    // postgresql://user:password@host 형식에서 비밀번호 부분 찾기
    const urlMatch = cleanConnectionString.match(/^(postgresql?:\/\/)([^:]+):([^@]+)@(.+)$/);
    
    if (urlMatch) {
        const [, protocol, username, password, rest] = urlMatch;
        
        // 비밀번호에 특수문자가 있는지 확인 (이미 인코딩된 %는 제외)
        const needsEncoding = password && !password.includes('%') && 
            (password.includes('/') || password.includes('@') || password.includes(':') || 
             password.includes('#') || password.includes('&') || password.includes('=') ||
             password.includes('?') || password.includes('%') || password.includes(' '));
        
        if (needsEncoding) {
            console.log('⚠️  [DB Init] Password contains special characters, encoding...');
            const encodedPassword = encodeURIComponent(password);
            cleanConnectionString = `${protocol}${username}:${encodedPassword}@${rest}`;
            console.log('✅ [DB Init] Password encoded successfully');
        } else if (password && password.includes('%')) {
            console.log('✅ [DB Init] Password appears to be already encoded');
        }
    }
    
    // 최종 검증: cleanConnectionString이 유효한지 확인
    if (!cleanConnectionString || cleanConnectionString.length < 20) {
        console.error('❌ [DB Init] DATABASE_URL is too short to be valid');
        throw new Error('DATABASE_URL appears to be invalid (too short)');
    }
    
    console.log('✅ [DB Init] DATABASE_URL validation passed, creating pool...');
    console.log('   Connection string length:', cleanConnectionString.length);
    
    // 최종 검증: cleanConnectionString이 실제로 존재하는지
    if (!cleanConnectionString || typeof cleanConnectionString !== 'string') {
        console.error('❌ [DB Init] cleanConnectionString is invalid:', typeof cleanConnectionString);
        throw new Error('Invalid connection string after processing');
    }
    
    try {
        // Pool 생성 시 connectionString이 명시적으로 전달되는지 확인
        const poolConfig = {
            connectionString: cleanConnectionString,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
            max: 20, // 최대 연결 수
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000, // 연결 타임아웃 증가
        };
        
        console.log('   Pool config connectionString type:', typeof poolConfig.connectionString);
        console.log('   Pool config connectionString length:', poolConfig.connectionString ? poolConfig.connectionString.length : 'N/A');
        
        pool = new Pool(poolConfig);
        console.log('✅ [DB Init] Pool created successfully');
    } catch (error) {
        console.error('❌ [DB Init] Failed to create Pool:', error);
        console.error('   Error type:', error.constructor.name);
        console.error('   Error message:', error.message);
        throw error;
    }
    
    // 연결 테스트
    try {
        console.log('🔍 [DB Init] Testing database connection...');
        console.log('   Pool exists:', !!pool);
        console.log('   Pool config type:', typeof pool?.options);
        
        const client = await pool.connect();
        console.log('✅ [DB Init] Client obtained, querying...');
        
        const result = await client.query('SELECT NOW()');
        console.log('✅ [DB Init] Database connected successfully:', result.rows[0].now);
        
        client.release();
        console.log('✅ [DB Init] Client released');
    } catch (error) {
        console.error('❌ [DB Init] Database connection test failed:', error);
        console.error('   Error type:', error.constructor.name);
        console.error('   Error message:', error.message);
        console.error('   Pool state:', {
            exists: !!pool,
            hasOptions: !!pool?.options,
            connectionStringType: typeof pool?.options?.connectionString,
        });
        if (error.stack) {
            console.error('   Stack trace:', error.stack);
        }
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

