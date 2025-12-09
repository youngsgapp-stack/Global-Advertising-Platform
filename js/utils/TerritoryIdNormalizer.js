/**
 * TerritoryIdNormalizer - Territory ID 정규화 유틸리티
 * 
 * Legacy 형식("texas", "singapore-0")과 새 형식("USA::TEXAS", "SGP::ADM1_003") 간 변환 처리
 * 경매, 영토 조회 등에서 ID 형식 불일치 문제 해결
 */

import { CONFIG, log } from '../config.js';
import { territoryManager } from '../core/TerritoryManager.js';

/**
 * Territory ID 정규화
 * 
 * @param {string} territoryId - 정규화할 Territory ID (Legacy 또는 New 형식)
 * @param {Object} territory - Territory 객체 (선택적, 있으면 더 정확한 변환 가능)
 * @returns {Object} { normalizedId: string, legacyId: string, countryIso: string|null }
 */
export function normalizeTerritoryId(territoryId, territory = null) {
    if (!territoryId || typeof territoryId !== 'string') {
        throw new Error('Territory ID는 비어있지 않은 문자열이어야 합니다');
    }
    
    // Territory 객체가 없으면 TerritoryManager에서 가져오기 시도
    if (!territory) {
        territory = territoryManager.getTerritory(territoryId);
    }
    
    let normalizedId = territoryId;
    let legacyId = territoryId;
    let countryIso = null;
    
    // 새 형식 확인 (ISO3::ADMIN_CODE 형식)
    if (territoryId.includes('::')) {
        const parts = territoryId.split('::');
        if (parts.length === 2 && parts[0].length === 3) {
            // 새 형식
            normalizedId = territoryId;
            countryIso = parts[0].toUpperCase();
            
            // Legacy ID 생성 시도 (territory 객체가 있으면)
            if (territory) {
                // territory.id가 legacy 형식이면 사용
                if (territory.id && !territory.id.includes('::')) {
                    legacyId = territory.id;
                } else {
                    // ADMIN_CODE에서 추출 시도
                    const adminCode = parts[1];
                    // 간단한 변환 시도 (실제로는 territory 데이터 필요)
                    legacyId = adminCode.toLowerCase().replace(/_/g, '-');
                }
            }
            
            log.debug(`[TerritoryIdNormalizer] New format detected: ${normalizedId} (countryIso: ${countryIso})`);
            return { normalizedId, legacyId, countryIso };
        }
    }
    
    // Legacy 형식 처리
    if (territory) {
        // Territory 객체에서 새 형식 ID 추출 시도
        const newTerritoryId = territory.properties?.territoryId || territory.territoryId;
        if (newTerritoryId && newTerritoryId.includes('::')) {
            normalizedId = newTerritoryId;
            const parts = newTerritoryId.split('::');
            if (parts.length === 2 && parts[0].length === 3) {
                countryIso = parts[0].toUpperCase();
            }
            legacyId = territoryId;
            
            log.debug(`[TerritoryIdNormalizer] Legacy format converted: ${territoryId} → ${normalizedId} (countryIso: ${countryIso})`);
            return { normalizedId, legacyId, countryIso };
        }
        
        // countryIso 추출 시도
        countryIso = territory.properties?.adm0_a3 || territory.countryIso;
        if (countryIso && countryIso.length === 3) {
            countryIso = countryIso.toUpperCase();
        } else {
            // countryCode에서 변환 시도
            const countryCode = territory.country || territory.properties?.country;
            if (countryCode) {
                const isoToSlugMap = territoryManager.createIsoToSlugMap();
                for (const [iso, slug] of Object.entries(isoToSlugMap)) {
                    if (slug === countryCode) {
                        countryIso = iso;
                        break;
                    }
                }
            }
        }
    }
    
    log.debug(`[TerritoryIdNormalizer] Legacy format: ${normalizedId} (countryIso: ${countryIso || 'UNKNOWN'})`);
    return { normalizedId, legacyId, countryIso };
}

/**
 * Territory ID 검색용 ID 목록 생성
 * Legacy와 New 형식 모두 검색할 수 있도록 ID 목록 반환
 * 
 * @param {string} territoryId - Territory ID
 * @param {Object} territory - Territory 객체 (선택적)
 * @returns {string[]} 검색할 ID 목록
 */
export function getTerritorySearchIds(territoryId, territory = null) {
    const { normalizedId, legacyId } = normalizeTerritoryId(territoryId, territory);
    
    const searchIds = [normalizedId];
    if (legacyId !== normalizedId) {
        searchIds.push(legacyId);
    }
    // 원본 ID도 추가 (다른 형식일 수 있음)
    if (territoryId !== normalizedId && territoryId !== legacyId) {
        searchIds.push(territoryId);
    }
    
    // 중복 제거
    return Array.from(new Set(searchIds));
}

/**
 * Territory ID가 새 형식인지 확인
 * 
 * @param {string} territoryId - Territory ID
 * @returns {boolean} 새 형식이면 true
 */
export function isNewFormat(territoryId) {
    return territoryId && territoryId.includes('::') && territoryId.split('::').length === 2;
}

/**
 * Territory ID가 Legacy 형식인지 확인
 * 
 * @param {string} territoryId - Territory ID
 * @returns {boolean} Legacy 형식이면 true
 */
export function isLegacyFormat(territoryId) {
    return territoryId && !isNewFormat(territoryId);
}

