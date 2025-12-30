/**
 * TerritoryAdapter - API 응답을 표준 Territory 모델로 변환
 * 
 * 핵심 원칙:
 * 1. 변환 로직은 이 클래스에서만 수행
 * 2. snake_case → camelCase 변환
 * 3. 타입 안전성 보장
 * 4. 일관성 검증
 */

import { log } from '../config.js';

// Enum 정의
export const Sovereignty = {
    UNCONQUERED: 'unconquered',
    PROTECTED: 'protected',
    RULED: 'ruled',
    CONTESTED: 'contested'
};

export const TerritoryStatus = {
    AVAILABLE: 'available',
    PROTECTED: 'protected',
    RULED: 'ruled',
    AUCTION: 'auction'
};

class TerritoryAdapter {
    /**
     * 백엔드 API 응답을 표준 Territory 모델로 변환
     * 
     * ⚠️ 런타임 스키마 검증 포함
     * 
     * @param {Object} apiResponse - 백엔드 API 응답 (snake_case)
     * @returns {Object} 표준 Territory 모델 (camelCase)
     * @throws {Error} 스키마 위반 시
     */
    toStandardModel(apiResponse) {
        // 기본 검증
        if (!apiResponse || !apiResponse.id) {
            throw new Error('Invalid API response: missing id');
        }

        // ⚠️ 런타임 스키마 검증: 필수 필드 확인
        this.validateSchema(apiResponse);

        // 날짜 문자열을 Date 객체로 변환하는 헬퍼
        const parseDate = (dateString) => {
            if (!dateString) return null;
            if (dateString instanceof Date) return dateString;
            const date = new Date(dateString);
            return isNaN(date.getTime()) ? null : date;
        };

        // sovereignty enum 변환
        const normalizeSovereignty = (value) => {
            if (!value) return Sovereignty.UNCONQUERED;
            const normalized = value.toLowerCase();
            if (Object.values(Sovereignty).includes(normalized)) {
                return normalized;
            }
            // 알 수 없는 값은 debug 레벨로만 로그 (대량 출력 방지)
            log.debug(`[TerritoryAdapter] Unknown sovereignty value: ${value}, using UNCONQUERED`);
            return Sovereignty.UNCONQUERED;
        };

        // status enum 변환
        // ⚠️ sovereignty 값을 status로 사용할 때 매핑 필요
        const normalizeStatus = (value, sovereigntyValue = null) => {
            if (!value) {
                // status가 없으면 sovereignty 기반으로 매핑
                if (sovereigntyValue) {
                    const sovNormalized = sovereigntyValue.toLowerCase();
                    if (sovNormalized === 'unconquered') {
                        return TerritoryStatus.AVAILABLE;
                    } else if (sovNormalized === 'protected') {
                        return TerritoryStatus.PROTECTED;
                    } else if (sovNormalized === 'ruled') {
                        return TerritoryStatus.RULED;
                    } else if (sovNormalized === 'contested') {
                        return TerritoryStatus.AUCTION;
                    }
                }
                return TerritoryStatus.AVAILABLE;
            }
            const normalized = value.toLowerCase();
            if (Object.values(TerritoryStatus).includes(normalized)) {
                return normalized;
            }
            // sovereignty 값을 status로 사용하려고 할 때 매핑 시도
            if (Object.values(Sovereignty).includes(normalized)) {
                // sovereignty 값을 status로 매핑
                if (normalized === 'unconquered') {
                    return TerritoryStatus.AVAILABLE;
                } else if (normalized === 'protected') {
                    return TerritoryStatus.PROTECTED;
                } else if (normalized === 'ruled') {
                    return TerritoryStatus.RULED;
                } else if (normalized === 'contested') {
                    return TerritoryStatus.AUCTION;
                }
            }
            // 알 수 없는 값은 debug 레벨로만 로그 (4000개 이상 출력 방지)
            log.debug(`[TerritoryAdapter] Unknown status value: ${value}, using AVAILABLE`);
            return TerritoryStatus.AVAILABLE;
        };

        // ⚠️ 전문가 조언 반영: 백엔드 응답 계약을 ruler_firebase_uid 하나로 통일
        // 한 줄의 규칙으로만 표준화 (여러 필드를 if로 처리하지 않음)
        // ⚠️ 핵심 수정: 문자열 'null'도 실제 null로 처리
        const rulerRaw = apiResponse.ruler_firebase_uid;
        const ruler = (!rulerRaw || (typeof rulerRaw === 'string' && rulerRaw.toLowerCase() === 'null')) ? null : rulerRaw;

        // rulerName: ruler_nickname 우선 (백엔드가 ruler_nickname으로 통일)
        const rulerName = apiResponse.ruler_nickname || apiResponse.ruler_name || null;

        // 표준 모델 생성
        const standardModel = {
            // === 식별자 ===
            id: apiResponse.id,
            code: apiResponse.code || apiResponse.id,

            // === 소유권 정보 ===
            ruler: ruler,
            rulerId: apiResponse.ruler_id || null,
            rulerName: rulerName,
            rulerSince: parseDate(apiResponse.ruler_since || apiResponse.acquired_at),

            // === 주권 상태 ===
            sovereignty: normalizeSovereignty(apiResponse.sovereignty),
            status: normalizeStatus(apiResponse.status || null, apiResponse.sovereignty),

            // === 보호 기간 ===
            protectionEndsAt: parseDate(apiResponse.protection_ends_at),
            protectionDays: apiResponse.protection_days || null,

            // === 가격 정보 ===
            // ⚠️ 전문가 조언 반영: last_winning_amount 포함 (Price 표시에 필요)
            last_winning_amount: apiResponse.last_winning_amount ? parseFloat(apiResponse.last_winning_amount) : null,
            basePrice: parseFloat(apiResponse.base_price || apiResponse.price || 0),
            purchasedPrice: apiResponse.purchased_price ? parseFloat(apiResponse.purchased_price) : null,

            // === 관리자 관련 ===
            purchasedByAdmin: Boolean(apiResponse.purchased_by_admin),

            // === 지리 정보 ===
            country: apiResponse.country || null,
            countryCode: apiResponse.country_code || apiResponse.country || null,

            // === 이름 정보 ===
            name: this.normalizeName(apiResponse),
            displayName: this.normalizeDisplayName(apiResponse),

            // === 지오메트리 ===
            geometry: apiResponse.geometry || apiResponse.polygon || null,
            properties: apiResponse.properties || {},

            // === 메타데이터 ===
            createdAt: parseDate(apiResponse.created_at) || new Date(),
            updatedAt: parseDate(apiResponse.updated_at) || new Date(),
            history: apiResponse.history || [],

            // === 픽셀 아트 ===
            hasPixelArt: Boolean(apiResponse.has_pixel_art || apiResponse.pixel_data),
            pixelArtUpdatedAt: parseDate(apiResponse.pixel_art_updated_at),

            // === 경매 정보 ===
            currentAuction: apiResponse.current_auction ? this.normalizeAuction(apiResponse.current_auction) : undefined
        };

        // 일관성 검증
        this.validateConsistency(standardModel);

        return standardModel;
    }

    /**
     * 이름 정보 정규화
     */
    normalizeName(apiResponse) {
        // 이미 객체인 경우
        if (apiResponse.name && typeof apiResponse.name === 'object') {
            return {
                en: apiResponse.name.en || apiResponse.name_en || apiResponse.id,
                local: apiResponse.name.local || apiResponse.name_local,
                ko: apiResponse.name.ko || apiResponse.name_ko
            };
        }

        // 문자열인 경우
        if (typeof apiResponse.name === 'string') {
            return {
                en: apiResponse.name,
                local: apiResponse.name_local,
                ko: apiResponse.name_ko
            };
        }

        // name_en이 있는 경우
        if (apiResponse.name_en) {
            return {
                en: apiResponse.name_en,
                local: apiResponse.name_local,
                ko: apiResponse.name_ko
            };
        }

        // 기본값
        return {
            en: apiResponse.id || 'Unknown Territory',
            local: null,
            ko: null
        };
    }

    /**
     * 표시용 이름 정규화
     */
    normalizeDisplayName(apiResponse) {
        const name = this.normalizeName(apiResponse);
        
        return {
            en: name.en,
            local: name.local || name.en,
            ko: name.ko || null,
            hasLocalMapping: Boolean(name.local && name.local !== name.en)
        };
    }

    /**
     * 경매 정보 정규화
     */
    normalizeAuction(auctionData) {
        const parseDate = (dateString) => {
            if (!dateString) return null;
            if (dateString instanceof Date) return dateString;
            const date = new Date(dateString);
            return isNaN(date.getTime()) ? null : date;
        };

        return {
            id: auctionData.id || auctionData.auction_id,
            territoryId: auctionData.territory_id || auctionData.territoryId,
            currentBid: parseFloat(auctionData.current_bid || auctionData.currentBid || 0),
            highestBidder: auctionData.highest_bidder || auctionData.highestBidder || null,
            endsAt: parseDate(auctionData.ends_at || auctionData.endTime),
            status: (auctionData.status || 'active').toLowerCase()
        };
    }

    /**
     * 일관성 검증
     * 
     * @param {Object} territory - 표준 모델
     * @throws {Error} 일관성 위반 시
     */
    validateConsistency(territory) {
        // 소유권 일관성
        if (!territory.ruler) {
            if (territory.rulerId !== null || territory.rulerName !== null) {
                log.warn(`[TerritoryAdapter] Inconsistent ownership: ruler is null but rulerId/rulerName exist`, {
                    id: territory.id,
                    rulerId: territory.rulerId,
                    rulerName: territory.rulerName
                });
            }
            
            // 미소유 상태는 UNCONQUERED여야 함
            if (territory.sovereignty !== Sovereignty.UNCONQUERED && 
                territory.sovereignty !== Sovereignty.CONTESTED) {
                log.warn(`[TerritoryAdapter] Inconsistent sovereignty: no ruler but sovereignty is ${territory.sovereignty}`, {
                    id: territory.id,
                    sovereignty: territory.sovereignty
                });
            }
        } else {
            // 소유자가 있으면 PROTECTED 또는 RULED여야 함
            if (territory.sovereignty === Sovereignty.UNCONQUERED) {
                log.warn(`[TerritoryAdapter] Inconsistent sovereignty: has ruler but sovereignty is UNCONQUERED`, {
                    id: territory.id,
                    ruler: territory.ruler,
                    sovereignty: territory.sovereignty
                });
            }
        }

        // 보호 기간 일관성
        if (!territory.protectionEndsAt && territory.protectionDays !== null) {
            log.warn(`[TerritoryAdapter] Inconsistent protection: protectionEndsAt is null but protectionDays is set`, {
                id: territory.id,
                protectionDays: territory.protectionDays
            });
        }

        // 보호 기간이 지났으면 RULED여야 함
        if (territory.protectionEndsAt && 
            new Date() >= territory.protectionEndsAt && 
            territory.sovereignty === Sovereignty.PROTECTED) {
            log.warn(`[TerritoryAdapter] Protection expired but sovereignty is still PROTECTED`, {
                id: territory.id,
                protectionEndsAt: territory.protectionEndsAt,
                sovereignty: territory.sovereignty
            });
        }
    }

    /**
     * 런타임 스키마 검증
     * API 응답이 계약과 다르면 즉시 에러
     * 
     * ⚠️ PostgreSQL 응답은 숫자를 문자열로 반환할 수 있으므로, 
     * 숫자 문자열을 숫자로 변환하는 로직 포함
     * 
     * @param {Object} apiResponse - API 응답
     * @throws {Error} 스키마 위반 시
     */
    validateSchema(apiResponse) {
        const errors = [];

        // 필수 필드 검증
        if (!apiResponse.id || typeof apiResponse.id !== 'string') {
            errors.push('id must be a non-empty string');
        }

        // 소유권 관련 필드 검증 (타입 체크)
        if (apiResponse.ruler_firebase_uid !== undefined && 
            apiResponse.ruler_firebase_uid !== null && 
            typeof apiResponse.ruler_firebase_uid !== 'string') {
            errors.push('ruler_firebase_uid must be a string or null');
        }

        // ruler_id 검증: 숫자 또는 숫자 문자열 허용 (PostgreSQL은 숫자를 문자열로 반환할 수 있음)
        // 빈 문자열, 공백 문자열, UUID 문자열은 null로 처리 (UUID는 ruler_firebase_uid로 별도 처리)
        if (apiResponse.ruler_id !== undefined && apiResponse.ruler_id !== null) {
            const rulerId = apiResponse.ruler_id;
            const isNumber = typeof rulerId === 'number';
            
            // 빈 문자열이나 공백 문자열은 null로 처리
            if (typeof rulerId === 'string' && rulerId.trim() === '') {
                log.debug(`[TerritoryAdapter] Converting empty ruler_id string to null for territory ${apiResponse.id}`);
                apiResponse.ruler_id = null;
            } else if (typeof rulerId === 'string') {
                const trimmedId = rulerId.trim();
                
                // UUID 패턴 감지 (예: 'd9066c4b-3342-49d1-b251-17547675e6ac')
                const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                if (uuidPattern.test(trimmedId)) {
                    // UUID가 ruler_id로 오면, 이것은 잘못된 매핑일 가능성이 높음
                    // ruler_firebase_uid로 이동시키고 ruler_id는 null로 처리
                    log.warn(`[TerritoryAdapter] UUID found in ruler_id field for territory ${apiResponse.id}, treating as ruler_firebase_uid instead`);
                    if (!apiResponse.ruler_firebase_uid) {
                        apiResponse.ruler_firebase_uid = trimmedId;
                    }
                    apiResponse.ruler_id = null;
                } else {
                    // 숫자 문자열인지 확인
                    const isNumericString = /^\d+$/.test(trimmedId);
                    
                    if (isNumericString) {
                        // 숫자 문자열을 숫자로 변환 (이후 toStandardModel에서 사용)
                        const parsedId = parseInt(trimmedId, 10);
                        if (isNaN(parsedId)) {
                            errors.push('ruler_id must be a number or null');
                        } else {
                            apiResponse.ruler_id = parsedId;
                        }
                    } else {
                        // 숫자가 아닌 문자열 (UUID도 아닌 경우)
                        log.warn(`[TerritoryAdapter] Invalid ruler_id type for territory ${apiResponse.id}:`, {
                            type: typeof rulerId,
                            value: rulerId,
                            rulerIdStringified: String(rulerId)
                        });
                        errors.push('ruler_id must be a number or null');
                    }
                }
            } else if (!isNumber) {
                // 숫자도 문자열도 아닌 경우
                log.warn(`[TerritoryAdapter] Invalid ruler_id type for territory ${apiResponse.id}:`, {
                    type: typeof rulerId,
                    value: rulerId
                });
                errors.push('ruler_id must be a number or null');
            }
        }

        if (apiResponse.ruler_name !== undefined && 
            apiResponse.ruler_name !== null && 
            typeof apiResponse.ruler_name !== 'string') {
            errors.push('ruler_name must be a string or null');
        }

        // sovereignty 검증
        if (apiResponse.sovereignty !== undefined && 
            apiResponse.sovereignty !== null && 
            typeof apiResponse.sovereignty !== 'string') {
            errors.push('sovereignty must be a string or null');
        }

        // base_price 검증: 숫자 또는 숫자 문자열 허용 (PostgreSQL은 숫자를 문자열로 반환할 수 있음)
        if (apiResponse.base_price !== undefined && apiResponse.base_price !== null) {
            const basePrice = apiResponse.base_price;
            const isNumber = typeof basePrice === 'number';
            const isNumericString = typeof basePrice === 'string' && /^-?\d+(\.\d+)?$/.test(basePrice);
            
            if (!isNumber && !isNumericString) {
                errors.push('base_price must be a non-negative number');
            } else {
                const numericValue = isNumber ? basePrice : parseFloat(basePrice);
                if (isNaN(numericValue) || numericValue < 0) {
                    errors.push('base_price must be a non-negative number');
                } else if (isNumericString) {
                    // 숫자 문자열을 숫자로 변환 (이후 toStandardModel에서 사용)
                    apiResponse.base_price = numericValue;
                }
            }
        }

        // 에러가 있으면 즉시 던지기 (조용히 undefined 퍼지는 것 방지)
        if (errors.length > 0) {
            const errorMessage = `[TerritoryAdapter] Schema validation failed for territory ${apiResponse.id}:\n${errors.join('\n')}`;
            log.error(errorMessage, { apiResponse, errors });
            throw new Error(errorMessage);
        }
    }

    /**
     * 여러 영토를 일괄 변환
     * 
     * @param {Array} apiResponses - API 응답 배열
     * @returns {Array} 표준 모델 배열
     */
    toStandardModels(apiResponses) {
        if (!Array.isArray(apiResponses)) {
            return [];
        }

        return apiResponses
            .map(response => {
                try {
                    return this.toStandardModel(response);
                } catch (error) {
                    log.error(`[TerritoryAdapter] Failed to convert territory:`, {
                        response,
                        error: error.message
                    });
                    return null;
                }
            })
            .filter(territory => territory !== null);
    }
}

// 싱글톤 인스턴스
export const territoryAdapter = new TerritoryAdapter();

