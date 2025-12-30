/**
 * 단일 마이그레이션 파일 실행 스크립트
 * 
 * 사용법:
 *   node backend/scripts/run-single-migration.js 004_add_last_winning_amount.sql
 */

import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initDatabase, getPool } from '../db/init.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 환경 변수 로드
dotenv.config();

async function main() {
    const migrationFile = process.argv[2];
    
    if (!migrationFile) {
        console.error('❌ [Migration] Migration file name is required');
        console.error('Usage: node run-single-migration.js <migration-file>');
        console.error('Example: node run-single-migration.js 004_add_last_winning_amount.sql');
        process.exit(1);
    }
    
    try {
        console.log(`🔄 [Migration] Starting migration: ${migrationFile}`);
        
        // DB 초기화
        await initDatabase();
        console.log('✅ [Migration] Database initialized');
        
        const pool = getPool();
        
        // 마이그레이션 파일 경로
        const migrationPath = join(__dirname, '..', 'db', 'migrations', migrationFile);
        
        // 파일 읽기
        console.log(`📖 [Migration] Reading migration file: ${migrationPath}`);
        const sql = readFileSync(migrationPath, 'utf8');
        
        // 마이그레이션 실행
        console.log(`🚀 [Migration] Executing migration...`);
        await pool.query(sql);
        
        // 실행 이력 저장
        const schemaMigrationsResult = await pool.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                id SERIAL PRIMARY KEY,
                filename VARCHAR(255) UNIQUE NOT NULL,
                executed_at TIMESTAMP DEFAULT NOW()
            )
        `);
        
        // 이미 실행된 마이그레이션인지 확인
        const checkResult = await pool.query(
            'SELECT * FROM schema_migrations WHERE filename = $1',
            [migrationFile]
        );
        
        if (checkResult.rows.length === 0) {
            await pool.query(
                'INSERT INTO schema_migrations (filename) VALUES ($1)',
                [migrationFile]
            );
            console.log(`✅ [Migration] Migration executed and logged: ${migrationFile}`);
        } else {
            console.log(`⚠️  [Migration] Migration already executed: ${migrationFile}`);
        }
        
        console.log('✅ [Migration] Migration completed successfully');
        process.exit(0);
    } catch (error) {
        console.error('❌ [Migration] Migration failed:', error);
        console.error('Error details:', {
            message: error.message,
            stack: error.stack
        });
        process.exit(1);
    }
}

main();

