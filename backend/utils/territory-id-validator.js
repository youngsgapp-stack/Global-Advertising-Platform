/**
 * Territory ID 검증 및 변환 유틸리티
 * 
 * 전문가 조언 반영: ID 계약 강제
 * - Canonical ID: DB PK, 권한 체크, 결제/포인트, 픽셀 저장, 모든 참조키에 사용
 * - Display ID: UI/표시/검색/그룹핑용 (예: "USA::texas")
 * 
 * 현재 시스템: Canonical = "texas", Display = "USA::texas"
 */

/**
 * Display ID에서 Canonical ID 추출
 * @param {string} territoryId - Display ID (예: "USA::texas") 또는 Canonical ID (예: "texas")
 * @returns {string} Canonical ID (예: "texas")
 */
function getCanonicalId(territoryId) {
    if (!territoryId || typeof territoryId !== 'string') {
        return territoryId;
    }
    
    // Display ID 형식인지 확인 (COUNTRY::ADMIN 형식)
    const parts = territoryId.split('::');
    if (parts.length === 2) {
        const [countryIso, adminCode] = parts;
        if (countryIso && adminCode) {
            // Display ID인 경우 adminCode를 Canonical ID로 사용
            return adminCode.toLowerCase().trim();
        }
    }
    
    // 이미 Canonical ID인 경우 그대로 반환
    return territoryId.toLowerCase().trim();
}

/**
 * ID 검증 및 Canonical ID 변환
 * @param {string} territoryId - 입력된 ID (Display 또는 Canonical)
 * @param {object} options - 옵션
 * @param {boolean} options.strict - true면 Display ID가 들어오면 400 에러 반환
 * @param {boolean} options.autoConvert - true면 Display ID를 자동으로 Canonical로 변환
 * @returns {{ canonicalId: string, isDisplayId: boolean, originalId: string } | null} 변환 결과 또는 null (에러)
 */
function validateAndConvertTerritoryId(territoryId, options = {}) {
    const { strict = false, autoConvert = true } = options;
    
    if (!territoryId || typeof territoryId !== 'string') {
        return null;
    }
    
    const originalId = territoryId;
    const isDisplayId = territoryId.includes('::') && territoryId.split('::').length === 2;
    
    if (isDisplayId) {
        if (strict) {
            // Strict 모드: Display ID 거부
            return null;
        }
        
        if (autoConvert) {
            // Auto Convert 모드: Display ID를 Canonical로 변환
            const canonicalId = getCanonicalId(territoryId);
            return {
                canonicalId,
                isDisplayId: true,
                originalId
            };
        }
    }
    
    // Canonical ID인 경우
    return {
        canonicalId: territoryId.toLowerCase().trim(),
        isDisplayId: false,
        originalId
    };
}

/**
 * API 경로 파라미터에서 Territory ID 검증 및 변환
 * @param {string} territoryId - 경로 파라미터에서 받은 ID
 * @param {object} options - 옵션
 * @returns {{ canonicalId: string, error?: string } | null} 변환 결과 또는 null (에러)
 */
function validateTerritoryIdParam(territoryId, options = {}) {
    const { strict = false, autoConvert = true, logWarning = true } = options;
    
    const result = validateAndConvertTerritoryId(territoryId, { strict, autoConvert });
    
    if (!result) {
        return {
            canonicalId: null,
            error: strict 
                ? 'Display ID format not allowed. Use Canonical ID only.'
                : 'Invalid territory ID format'
        };
    }
    
    // Display ID가 들어왔고 autoConvert가 true면 경고 로그
    if (result.isDisplayId && autoConvert && logWarning) {
        console.warn(`[TerritoryIdValidator] Display ID converted to Canonical: "${result.originalId}" -> "${result.canonicalId}"`);
    }
    
    return {
        canonicalId: result.canonicalId,
        originalId: result.originalId,
        wasDisplayId: result.isDisplayId
    };
}

module.exports = {
    getCanonicalId,
    validateAndConvertTerritoryId,
    validateTerritoryIdParam
};

