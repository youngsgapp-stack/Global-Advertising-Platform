/**
 * Database Migration Runner
 * 마이그레이션 도구가 없으므로 수동으로 마이그레이션을 실행하는 시스템
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getPool } from './init.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 마이그레이션 파일 목록 가져오기 (번호 순서대로)
 */
function getMigrationFiles() {
    const migrationsDir = join(__dirname, 'migrations');
    const files = readdirSync(migrationsDir)
        .filter(file => file.endsWith('.sql'))
        .sort(); // 파일명으로 정렬 (001, 002, ...)
    
    return files.map(file => join(migrationsDir, file));
}

/**
 * 마이그레이션 실행
 */
export async function runMigrations() {
    const pool = getPool();
    
    try {
        // 마이그레이션 실행 이력 테이블 생성
        await pool.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                id SERIAL PRIMARY KEY,
                filename VARCHAR(255) UNIQUE NOT NULL,
                executed_at TIMESTAMP DEFAULT NOW()
            )
        `);
        
        const migrationFiles = await getMigrationFiles();
        console.log(`🔍 [Migrations] Found ${migrationFiles.length} migration files`);
        
        for (const filePath of migrationFiles) {
            const filename = filePath.split(/[/\\]/).pop();
            
            // 이미 실행된 마이그레이션인지 확인
            const checkResult = await pool.query(
                'SELECT * FROM schema_migrations WHERE filename = $1',
                [filename]
            );
            
            if (checkResult.rows.length > 0) {
                console.log(`⏭️  [Migrations] Skipping ${filename} (already executed)`);
                continue;
            }
            
            // 마이그레이션 실행
            console.log(`🔄 [Migrations] Running ${filename}...`);
            const sql = readFileSync(filePath, 'utf8');
            await pool.query(sql);
            
            // 실행 이력 저장
            await pool.query(
                'INSERT INTO schema_migrations (filename) VALUES ($1)',
                [filename]
            );
            
            console.log(`✅ [Migrations] Completed ${filename}`);
        }
        
        console.log(`✅ [Migrations] All migrations completed`);
    } catch (error) {
        console.error(`❌ [Migrations] Migration failed:`, error);
        throw error;
    }
}

/**
 * 스키마 검증 (필수 컬럼 확인)
 */
export async function validateSchema() {
    const pool = getPool();
    
    try {
        // 필수 컬럼 목록
        const requiredColumns = [
            { table: 'territories', column: 'market_base_price', type: 'DECIMAL(10,2)' }
        ];
        
        const missingColumns = [];
        
        for (const { table, column } of requiredColumns) {
            const result = await pool.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = $1 AND column_name = $2
            `, [table, column]);
            
            if (result.rows.length === 0) {
                missingColumns.push({ table, column });
            }
        }
        
        if (missingColumns.length > 0) {
            console.error(`❌ [Schema Validation] Missing required columns:`);
            missingColumns.forEach(({ table, column }) => {
                console.error(`   - ${table}.${column}`);
            });
            console.error(`\n⚠️  [Schema Validation] Please run migrations to fix this issue.`);
            console.error(`   Run: node scripts/run-migration.js`);
            
            // 개발 환경에서는 서버 시작을 막음
            if (process.env.NODE_ENV !== 'production') {
                throw new Error(`Schema validation failed: Missing required columns. Please run migrations.`);
            }
        } else {
            console.log(`✅ [Schema Validation] All required columns exist`);
        }
    } catch (error) {
        console.error(`❌ [Schema Validation] Validation failed:`, error);
        throw error;
    }
}

