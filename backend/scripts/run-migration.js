/**
 * 마이그레이션 실행 스크립트
 * 
 * 사용법:
 *   node backend/scripts/run-migration.js
 * 
 * 또는 특정 마이그레이션만 실행:
 *   node backend/scripts/run-migration.js 002_add_country_iso.sql
 */

import dotenv from 'dotenv';
import { runMigrations } from '../db/migrations.js';
import { initDatabase } from '../db/init.js';

// 환경 변수 로드 (.env 파일)
dotenv.config();

async function main() {
    try {
        console.log('🔄 [Migration Runner] Starting migrations...');
        
        // DB 초기화
        await initDatabase();
        console.log('✅ [Migration Runner] Database initialized');
        
        // 마이그레이션 실행
        await runMigrations();
        
        console.log('✅ [Migration Runner] All migrations completed successfully');
        process.exit(0);
    } catch (error) {
        console.error('❌ [Migration Runner] Migration failed:', error);
        process.exit(1);
    }
}

main();
