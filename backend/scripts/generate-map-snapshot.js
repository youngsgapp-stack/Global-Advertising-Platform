/**
 * 맵 스냅샷 JSON 생성 스크립트
 * CDN에 업로드할 맵 스냅샷 파일 생성
 */

import 'dotenv/config';
import { query, initDatabase } from '../db/init.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 출력 디렉토리
const OUTPUT_DIR = path.join(__dirname, '../../cdn/snapshots');

async function generateMapSnapshot() {
    console.log('🗺️  맵 스냅샷 생성 시작...\n');
    
    // DB 초기화
    await initDatabase();
    
    // 출력 디렉토리 생성
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    
    // DB에서 영토 목록 조회
    console.log('📊 영토 데이터 조회 중...');
    const result = await query(`
        SELECT 
            id,
            code,
            name,
            name_en,
            country,
            continent,
            status,
            ruler_id,
            ruler_name,
            sovereignty,
            base_price,
            current_auction_id,
            updated_at
        FROM territories
        ORDER BY updated_at DESC
    `);
    
    const snapshot = {
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        totalTerritories: result.rows.length,
        territories: result.rows.map(row => ({
            id: row.id,
            code: row.code,
            name: row.name,
            name_en: row.name_en,
            country: row.country,
            continent: row.continent,
            status: row.status,
            ruler: row.ruler_id ? {
                id: row.ruler_id,
                name: row.ruler_name,
            } : null,
            sovereignty: row.sovereignty,
            basePrice: parseFloat(row.base_price || 0),
            hasAuction: !!row.current_auction_id,
        }))
    };
    
    // JSON 파일로 저장
    const filename = `map-snapshot-${Date.now()}.json`;
    const filepath = path.join(OUTPUT_DIR, filename);
    
    fs.writeFileSync(filepath, JSON.stringify(snapshot, null, 2));
    
    // 최신 버전 링크 파일도 생성
    const latestPath = path.join(OUTPUT_DIR, 'map-snapshot-latest.json');
    fs.writeFileSync(latestPath, JSON.stringify(snapshot, null, 2));
    
    console.log(`✅ 맵 스냅샷 생성 완료:`);
    console.log(`   파일: ${filepath}`);
    console.log(`   최신: ${latestPath}`);
    console.log(`   영토 수: ${result.rows.length}개\n`);
    
    // 파일 크기 출력
    const stats = fs.statSync(filepath);
    console.log(`   파일 크기: ${(stats.size / 1024).toFixed(2)} KB\n`);
    
    process.exit(0);
}

generateMapSnapshot().catch(error => {
    console.error('❌ 스냅샷 생성 실패:', error);
    process.exit(1);
});









