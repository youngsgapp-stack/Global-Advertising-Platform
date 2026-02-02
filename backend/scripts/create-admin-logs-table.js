/**
 * admin_logs 테이블 생성 스크립트
 * 
 * 사용법:
 *   node backend/scripts/create-admin-logs-table.js
 * 
 * 또는 환경 변수 설정 후:
 *   DATABASE_URL="postgresql://..." node backend/scripts/create-admin-logs-table.js
 */

import { query, initDatabase } from '../db/init.js';
import dotenv from 'dotenv';

// .env 파일 로드
dotenv.config();

async function createAdminLogsTable() {
    try {
        console.log('🔄 admin_logs 테이블 생성 시작...\n');
        
        // 데이터베이스 초기화
        await initDatabase();
        console.log('✅ 데이터베이스 연결 완료\n');
        
        // admin_logs 테이블 생성
        console.log('📝 admin_logs 테이블 생성 중...');
        await query(`
            CREATE TABLE IF NOT EXISTS admin_logs (
              id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
              action VARCHAR(100) NOT NULL,
              details JSONB,
              admin_email VARCHAR(255),
              admin_uid VARCHAR(255),
              user_agent TEXT,
              ip_address VARCHAR(45),
              created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        console.log('✅ admin_logs 테이블 생성 완료\n');
        
        // 인덱스 생성
        console.log('📝 인덱스 생성 중...');
        await query(`
            CREATE INDEX IF NOT EXISTS idx_admin_logs_action ON admin_logs(action)
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_admin_logs_admin_email ON admin_logs(admin_email)
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_admin_logs_created_at ON admin_logs(created_at DESC)
        `);
        console.log('✅ 인덱스 생성 완료\n');
        
        // 테이블 확인
        const result = await query(`
            SELECT COUNT(*) as count FROM admin_logs
        `);
        console.log(`✅ 테이블 확인 완료 (현재 로그 수: ${result.rows[0].count}개)\n`);
        
        console.log('🎉 admin_logs 테이블 생성이 완료되었습니다!');
        console.log('   이제 관리자 로그 기능을 사용할 수 있습니다.\n');
        
        process.exit(0);
    } catch (error) {
        console.error('❌ 오류 발생:', error);
        console.error('\n해결 방법:');
        console.error('1. DATABASE_URL 환경 변수가 올바르게 설정되어 있는지 확인하세요.');
        console.error('2. 데이터베이스 연결이 정상인지 확인하세요.');
        console.error('3. PostgreSQL 사용자에게 테이블 생성 권한이 있는지 확인하세요.\n');
        process.exit(1);
    }
}

createAdminLogsTable();









