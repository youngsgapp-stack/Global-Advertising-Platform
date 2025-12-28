/**
 * 마이그레이션 실행 스크립트
 * 
 * 사용법:
 *   node scripts/run-migration.js                    # 모든 마이그레이션 실행
 *   node scripts/run-migration.js migrations/001_xxx.sql  # 특정 마이그레이션 실행
 */

import dotenv from 'dotenv';
import { initDatabase } from '../db/init.js';
import { runMigrations, validateSchema } from '../db/migrations.js';

dotenv.config();

async function main() {
    try {
        console.log('🚀 Starting migration process...');
        
        // DB 초기화
        await initDatabase();
        console.log('✅ Database connected');
        
        // 마이그레이션 실행
        console.log('🔄 Running migrations...');
        await runMigrations();
        console.log('✅ Migrations completed');
        
        // 스키마 검증
        console.log('🔍 Validating schema...');
        await validateSchema();
        console.log('✅ Schema validation passed');
        
        console.log('\n✅ All migrations completed successfully!');
        process.exit(0);
    } catch (error) {
        console.error('\n❌ Migration failed:', error);
        process.exit(1);
    }
}

main();

