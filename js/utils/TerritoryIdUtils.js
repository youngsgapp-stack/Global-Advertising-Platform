/**
 * Territory ID 유틸리티 함수
 * 
 * Territory ID 형식: "COUNTRY_ISO3::ADMIN_CODE"
 * 예: "SGP::ADM1_003", "USA::CA", "BWA::ADM1_001"
 * 
 * 이 형식은 전 세계에서 고유성을 보장하며, 이름 기반 매칭 문제를 해결합니다.
 */

/**
 * Territory ID 생성
 * @param {string} countryIso - 국가 ISO3 코드 (예: "SGP", "USA", "BWA")
 * @param {string} adminCode - 행정구역 코드 (예: "ADM1_003", "CA", "ne_id_1234")
 * @returns {string} Territory ID (예: "SGP::ADM1_003")
 */
export function createTerritoryId(countryIso, adminCode) {
    if (!countryIso || !adminCode) {
        throw new Error(`createTerritoryId: countryIso and adminCode are required. Got: countryIso=${countryIso}, adminCode=${adminCode}`);
    }
    
    // ISO 코드는 대문자로 정규화
    const normalizedCountryIso = String(countryIso).toUpperCase().trim();
    
    // adminCode는 문자열로 변환하고 공백 제거
    const normalizedAdminCode = String(adminCode).trim();
    
    if (!normalizedCountryIso || !normalizedAdminCode) {
        throw new Error(`createTerritoryId: countryIso and adminCode cannot be empty after normalization`);
    }
    
    return `${normalizedCountryIso}::${normalizedAdminCode}`;
}

/**
 * Territory ID 파싱
 * @param {string} territoryId - Territory ID (예: "SGP::ADM1_003")
 * @returns {{ countryIso: string, adminCode: string } | null} 파싱된 객체 또는 null
 */
export function parseTerritoryId(territoryId) {
    if (!territoryId || typeof territoryId !== 'string') {
        return null;
    }
    
    const parts = territoryId.split('::');
    if (parts.length !== 2) {
        return null;
    }
    
    const [countryIso, adminCode] = parts;
    
    if (!countryIso || !adminCode) {
        return null;
    }
    
    return {
        countryIso: countryIso.toUpperCase().trim(),
        adminCode: adminCode.trim()
    };
}

/**
 * Territory ID 유효성 검사
 * @param {string} territoryId - 검사할 Territory ID
 * @returns {boolean} 유효한 Territory ID인지 여부
 */
export function isValidTerritoryId(territoryId) {
    const parsed = parseTerritoryId(territoryId);
    return parsed !== null && parsed.countryIso.length === 3 && parsed.adminCode.length > 0;
}

/**
 * Legacy Territory ID 추출 (하위 호환용)
 * 
 * 기존 시스템에서 사용하던 이름 기반 ID를 추출합니다.
 * 예: "SGP::ADM1_003" -> "south-east" (만약 adminCode가 "south-east"를 의미한다면)
 * 
 * @param {string} territoryId - Territory ID
 * @param {object} feature - GeoJSON feature (선택적)
 * @returns {string | null} Legacy ID 또는 null
 */
export function getLegacyTerritoryId(territoryId, feature = null) {
    const parsed = parseTerritoryId(territoryId);
    if (!parsed) {
        return null;
    }
    
    // feature가 있으면 properties.name에서 추출 시도
    if (feature && feature.properties) {
        const name = feature.properties.name || feature.properties.name_en || feature.properties.NAME_1;
        if (name) {
            // 이름을 슬러그로 변환
            return String(name)
                .toLowerCase()
                .trim()
                .replace(/[^\w\s-]/g, '')
                .replace(/\s+/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-|-$/g, '');
        }
    }
    
    // adminCode가 이미 슬러그 형식이면 그대로 사용
    // 예: "SGP::south-east" -> "south-east"
    if (parsed.adminCode && !parsed.adminCode.startsWith('ADM') && !parsed.adminCode.startsWith('ne_')) {
        return parsed.adminCode.toLowerCase();
    }
    
    return null;
}

/**
 * GeoJSON feature에서 Territory ID 생성
 * 
 * feature의 properties에서 countryIso와 adminCode를 추출하여 Territory ID를 생성합니다.
 * 
 * @param {object} feature - GeoJSON feature
 * @returns {string | null} Territory ID 또는 null (필수 정보가 없으면)
 */
export function createTerritoryIdFromFeature(feature) {
    if (!feature || !feature.properties) {
        return null;
    }
    
    const props = feature.properties;
    
    // 1. countryIso 추출 (adm0_a3 우선)
    let countryIso = props.adm0_a3 || props.country_code || props.iso_a3;
    if (!countryIso) {
        return null;
    }
    
    // ISO 코드 정규화 (3자리 대문자)
    countryIso = String(countryIso).toUpperCase().trim();
    if (countryIso.length !== 3) {
        return null;
    }
    
    // 2. adminCode 추출 (우선순위: adm1_code > ne_id > gid > id)
    let adminCode = props.adm1_code || 
                   props.ne_id || 
                   props.gid || 
                   props.id ||
                   feature.id;
    
    if (!adminCode) {
        // adminCode가 없으면 feature.id 사용 (Mapbox feature ID)
        adminCode = feature.id;
    }
    
    if (!adminCode) {
        return null;
    }
    
    // adminCode 정규화
    adminCode = String(adminCode).trim();
    
    return createTerritoryId(countryIso, adminCode);
}

/**
 * Territory ID에서 국가 코드만 추출
 * @param {string} territoryId - Territory ID
 * @returns {string | null} 국가 ISO3 코드 또는 null
 */
export function getCountryIsoFromTerritoryId(territoryId) {
    const parsed = parseTerritoryId(territoryId);
    return parsed ? parsed.countryIso : null;
}

/**
 * Territory ID에서 행정구역 코드만 추출
 * @param {string} territoryId - Territory ID
 * @returns {string | null} 행정구역 코드 또는 null
 */
export function getAdminCodeFromTerritoryId(territoryId) {
    const parsed = parseTerritoryId(territoryId);
    return parsed ? parsed.adminCode : null;
}

