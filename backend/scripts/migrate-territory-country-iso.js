/**
 * Migration Script: Extract and populate countryIso for legacy territories
 * 
 * 전문가 조언 반영: 레거시 territory에 countryIso를 추출하여 저장
 * - 레거시 ID 형식 (예: "tamanghasset")은 ID만으로는 countryIso를 알 수 없음
 * - country 필드나 다른 소스에서 countryIso를 추출하여 저장
 * 
 * 실행 방법:
 *   node backend/scripts/migrate-territory-country-iso.js            (실제 업데이트)
 *   node backend/scripts/migrate-territory-country-iso.js --dry-run  (미리보기, DB 변경 없음)
 */

import dotenv from 'dotenv';
import { query, getPool, initDatabase } from '../db/init.js';

// 환경 변수 로드 (.env 파일)
dotenv.config();

// 국가명/슬러그를 ISO 3166-1 alpha-3로 변환하는 매핑
const COUNTRY_TO_ISO = {
    // 주요 국가들
    'algeria': 'DZA',
    'usa': 'USA',
    'united-states': 'USA',
    'united states': 'USA',
    'canada': 'CAN',
    'mexico': 'MEX',
    'south-korea': 'KOR',
    'korea': 'KOR',
    'japan': 'JPN',
    'china': 'CHN',
    'uk': 'GBR',
    'united-kingdom': 'GBR',
    'germany': 'DEU',
    'france': 'FRA',
    'italy': 'ITA',
    'spain': 'ESP',
    'india': 'IND',
    'brazil': 'BRA',
    'russia': 'RUS',
    'australia': 'AUS',
    'singapore': 'SGP',
    'malaysia': 'MYS',
    'indonesia': 'IDN',
    'thailand': 'THA',
    'vietnam': 'VNM',
    'philippines': 'PHL',
    'saudi-arabia': 'SAU',
    'uae': 'ARE',
    'qatar': 'QAT',
    'iran': 'IRN',
    'israel': 'ISR',
    'turkey': 'TUR',
    'egypt': 'EGY',
    'south-africa': 'ZAF',
    'nigeria': 'NGA',
    'kenya': 'KEN',
    'morocco': 'MAR',
    'tunisia': 'TUN',
    'mauritania': 'MRT',
    'mali': 'MLI',
    'niger': 'NER',
    'united-states-of-america': 'USA',
    // 추가 국가들...
};

// 레거시 territory ID에서 국가를 추론하는 매핑 (특수 케이스)
const LEGACY_ID_TO_COUNTRY = {
    'tamanghasset': 'algeria', // 알제리
    'tamanrasset': 'algeria',
    // 추가 레거시 ID 매핑...
};

/**
 * 국가명/슬러그를 ISO 코드로 변환
 */
function convertToISO(countryName) {
    if (!countryName) return null;
    
    // 정규화: 소문자, 공백을 하이픈으로
    const normalized = countryName.toLowerCase().trim().replace(/\s+/g, '-');
    
    // 직접 매핑 확인 (부분 문자열 매칭은 'and'(안도라)→'thailand' 같은 오매핑을 만들어 사용하지 않음)
    if (COUNTRY_TO_ISO[normalized]) {
        return COUNTRY_TO_ISO[normalized];
    }
    
    // country 컬럼에 이미 3자리 국가 코드(Natural Earth adm0_a3, 소문자)가 저장된 경우
    if (/^[a-z]{3}$/.test(normalized)) {
        return normalized.toUpperCase();
    }
    
    return null;
}

/**
 * 레거시 territory ID에서 국가 추론
 */
function inferCountryFromLegacyId(territoryId) {
    // 레거시 ID 매핑 확인
    if (LEGACY_ID_TO_COUNTRY[territoryId]) {
        return LEGACY_ID_TO_COUNTRY[territoryId];
    }
    
    // ID에서 국가명 추출 시도 (예: "algeria-0" -> "algeria")
    const parts = territoryId.split('-');
    if (parts.length > 0) {
        const possibleCountry = parts[0];
        if (COUNTRY_TO_ISO[possibleCountry]) {
            return possibleCountry;
        }
    }
    
    return null;
}

/**
 * territory의 countryIso 추출 및 업데이트
 */
async function migrateTerritoryCountryIso({ dryRun = false } = {}) {
    console.log(`[Migration] Starting countryIso migration for legacy territories...${dryRun ? ' (DRY RUN: no changes)' : ''}`);
    const plannedByIso = new Map();
    const skippedByCountry = new Map();
    
    try {
        // DB 초기화
        await initDatabase();
        console.log('[Migration] ✅ Database initialized');
        // 전체 territory를 조회해서, countryIso가 없거나 country 값과 맞지 않게 잘못 저장된 것을 수정
        const result = await query(`
            SELECT id, country, country_iso, name, name_en
            FROM territories
            ORDER BY id
        `);
        
        let updated = 0;
        let corrected = 0;
        let skipped = 0;
        const errors = [];
        const corrections = [];
        
        for (const row of result.rows) {
            const territoryId = row.id;
            const country = row.country;
            let countryIso = null;
            
            // 방법 1: country 필드에서 추출
            if (country) {
                countryIso = convertToISO(country);
            }
            
            // 방법 2: 레거시 ID에서 추론
            if (!countryIso) {
                const inferredCountry = inferCountryFromLegacyId(territoryId);
                if (inferredCountry) {
                    countryIso = convertToISO(inferredCountry);
                }
            }
            
            // 방법 3: name_en에서 국가명 추출 시도 (간단한 휴리스틱)
            if (!countryIso && row.name_en) {
                // name_en이 국가명을 포함할 수 있음 (예: "Algeria - Tamanrasset")
                const nameParts = row.name_en.split(/[-–—]/);
                for (const part of nameParts) {
                    const trimmed = part.trim().toLowerCase().replace(/\s+/g, '-');
                    // 지역명은 3글자 코드 규칙을 적용하지 않고 국가명 정확 일치만 사용
                    const iso = COUNTRY_TO_ISO[trimmed];
                    if (iso) {
                        countryIso = iso;
                        break;
                    }
                }
            }
            
            // 이미 올바른 값이면 건너뜀, 판단 불가인데 기존 값이 있으면 기존 값 유지
            if (countryIso && countryIso === row.country_iso) {
                continue;
            }
            if (!countryIso && row.country_iso) {
                continue;
            }
            if (countryIso && row.country_iso) {
                corrected++;
                corrections.push(`${territoryId}(${country}: ${row.country_iso}→${countryIso})`);
            }
            
            if (countryIso && dryRun) {
                plannedByIso.set(countryIso, (plannedByIso.get(countryIso) || 0) + 1);
                updated++;
            } else if (countryIso) {
                try {
                    await query(`
                        UPDATE territories
                        SET country_iso = $1, updated_at = NOW()
                        WHERE id = $2
                    `, [countryIso, territoryId]);
                    
                    updated++;
                } catch (error) {
                    console.error(`[Migration] ❌ Failed to update ${territoryId}:`, error.message);
                    errors.push({ territoryId, error: error.message });
                }
            } else {
                if (dryRun) {
                    const key = country || 'null';
                    skippedByCountry.set(key, (skippedByCountry.get(key) || 0) + 1);
                } else {
                    console.warn(`[Migration] ⚠️  Skipped ${territoryId}: Could not determine countryIso (country: ${country || 'null'})`);
                }
                skipped++;
            }
        }
        
        if (dryRun) {
            const top = (map) => [...map].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k}=${v}`).join(', ');
            console.log(`\n[Migration] Would update by countryIso: ${top(plannedByIso)}`);
            console.log(`[Migration] Would skip by country value (top 25): ${top(skippedByCountry)}`);
        }
        
        if (corrections.length > 0) {
            console.log(`\n[Migration] ${dryRun ? 'Would correct' : 'Corrected'} wrong values: ${corrections.join(', ')}`);
        }
        
        console.log('\n[Migration] Summary:');
        console.log(`  - ${dryRun ? 'Would update' : 'Updated'}: ${updated} (of which corrections: ${corrected})`);
        console.log(`  - Skipped (could not determine): ${skipped}`);
        console.log(`  - Errors: ${errors.length}`);
        
        if (errors.length > 0) {
            console.log('\n[Migration] Errors:');
            errors.forEach(({ territoryId, error }) => {
                console.log(`  - ${territoryId}: ${error}`);
            });
        }
        
        console.log('\n[Migration] ✅ Migration completed!');
        
    } catch (error) {
        console.error('[Migration] ❌ Migration failed:', error);
        throw error;
    }
}

// 스크립트 실행
// Windows와 Unix 경로 모두 지원
const isMainModule = import.meta.url === `file://${process.argv[1]}` || 
                     import.meta.url.replace(/\\/g, '/').endsWith(process.argv[1].replace(/\\/g, '/'));

if (isMainModule || process.argv[1]?.includes('migrate-territory-country-iso')) {
    migrateTerritoryCountryIso({ dryRun: process.argv.includes('--dry-run') })
        .then(() => {
            console.log('[Migration] Script completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('[Migration] Script failed:', error);
            process.exit(1);
        });
}

export { migrateTerritoryCountryIso };

