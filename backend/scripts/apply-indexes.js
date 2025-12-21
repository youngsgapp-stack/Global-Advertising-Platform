import 'dotenv/config';
import { initDatabase, query, getPool } from '../db/init.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const indexesFile = path.join(__dirname, '../db/indexes.sql');

async function applyIndexes() {
    console.log('🚀 인덱스 적용 시작...\n');

    try {
        await initDatabase();

        // 인덱스 SQL 파일 읽기
        if (!fs.existsSync(indexesFile)) {
            console.error(`❌ 인덱스 파일을 찾을 수 없습니다: ${indexesFile}`);
            process.exit(1);
        }

        const indexesSQL = fs.readFileSync(indexesFile, 'utf8');
        
        // SQL 문을 세미콜론으로 분리 (간단한 파싱)
        const statements = indexesSQL
            .split(';')
            .map(s => s.trim())
            .filter(s => s.length > 0 && !s.startsWith('--'));

        console.log(`📋 총 ${statements.length}개의 인덱스 문 발견\n`);

        let successCount = 0;
        let skipCount = 0;
        let errorCount = 0;

        for (const statement of statements) {
            try {
                // IF NOT EXISTS가 있으면 이미 존재하는 인덱스는 자동으로 스킵됨
                await query(statement + ';');
                successCount++;
                // 인덱스 이름 추출 (CREATE INDEX IF NOT EXISTS idx_name...)
                const indexMatch = statement.match(/CREATE INDEX IF NOT EXISTS\s+(\S+)/i);
                if (indexMatch) {
                    console.log(`✅ ${indexMatch[1]}`);
                } else {
                    console.log(`✅ 인덱스 생성 완료`);
                }
            } catch (error) {
                // 이미 존재하는 인덱스 오류는 스킵
                if (error.message && error.message.includes('already exists')) {
                    skipCount++;
                    console.log(`⚠️  인덱스가 이미 존재함 (스킵)`);
                } else {
                    errorCount++;
                    console.error(`❌ 인덱스 생성 실패:`, error.message);
                }
            }
        }

        console.log('\n📊 결과:');
        console.log(`   ✅ 성공: ${successCount}개`);
        console.log(`   ⚠️  스킵: ${skipCount}개`);
        console.log(`   ❌ 실패: ${errorCount}개`);

        if (errorCount === 0) {
            console.log('\n✅ 모든 인덱스 적용 완료!');
        } else {
            console.log('\n⚠️  일부 인덱스 적용에 실패했습니다.');
        }

    } catch (error) {
        console.error('❌ 인덱스 적용 실패:', error);
        process.exit(1);
    } finally {
        getPool().end();
    }
}

applyIndexes();





