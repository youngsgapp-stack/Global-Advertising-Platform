/**
 * ApiService - 諛깆뿏??REST API ?占쎈씪?占쎌뼵?? * Firestore ?占???占쎈줈??諛깆뿏??API占??占쎌슜
 */

import { CONFIG, log } from '../config.js';
import { firebaseService } from './FirebaseService.js';
import { eventBus, EVENTS } from '../core/EventBus.js';

class ApiService {
    constructor() {
        this.baseUrl = CONFIG.API_BASE_URL || 'http://localhost:3000/api';
        this.initialized = false;
        
        // ⚠️ 공개 엔드포인트 목록 (인증 없이 접근 가능)
        // 나머지는 무조건 인증 필요
        this.PUBLIC_ENDPOINTS = [
            '/territories',           // 영토 목록 조회 (공개)
            '/territories/:id',       // 영토 상세 조회 (공개)
            '/territories/:id/pixels', // 픽셀 조회 (GET) - 게스트 허용
            '/pixels/territories',    // 픽셀 메타 목록 (GET) - 게스트 허용
            '/auctions',              // 경매 목록 조회 (공개)
            '/auctions/:id',          // 경매 상세 조회 (공개)
            '/health',                // 헬스 체크
            '/map/snapshot'           // 맵 스냅샷 (공개)
        ];
        
        // ⚠️ 인증 필수 엔드포인트 (절대 optional auth가 섞이면 안 됨)
        // ⚡ GET /territories/:id/pixels는 PUBLIC_ENDPOINTS에 있으므로 제외
        // POST/PUT/DELETE는 백엔드 라우터에서 인증 체크
        this.AUTH_REQUIRED_ENDPOINTS = [
            '/territories/:id/purchase',  // 구매
            '/auctions/:id/bids',         // 입찰
            '/users/me',                  // 사용자 정보
            '/users/me/wallet',           // 지갑 정보
            '/admin'                      // 관리자 엔드포인트 (모든 /admin/* 포함)
        ];
    }
    
    /**
     * 珥덇린??     */
    async initialize() {
        if (this.initialized) {
            return true;
        }
        
        // ?占쎄꼍???占쎈씪 API URL ?占쎌젙
        if (CONFIG.API_BASE_URL) {
            // config.js?占쎌꽌 ?占쏙옙? ?占쎌젙??URL ?占쎌슜
            this.baseUrl = CONFIG.API_BASE_URL;
        } else if (typeof window !== 'undefined') {
            // ?占쎈줈?占쎌뀡 ?占쎄꼍 ?占쎈룞 媛먲옙?
            const hostname = window.location.hostname;
            const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0';
            
            if (isLocalhost) {
                // 濡쒖뺄 媛쒕컻 ?占쎄꼍
                this.baseUrl = 'http://localhost:3000/api';
            } else {
                // ?占쎈줈?占쎌뀡 ?占쎄꼍 (localhost媛 ?占쎈땶 紐⑤뱺 寃쎌슦)
                // 프로덕션: 현재 origin 사용 (Vercel 자동 인식)
                const origin = window.location.origin;
                this.baseUrl = `${origin}/api`;
            }
        } else {
            // 湲곕낯占?(?占쎈쾭 ?占쎌씠???占쎈뜑占???
            this.baseUrl = 'http://localhost:3000/api';
        }
        
        this.initialized = true;
        log.info(`[ApiService] ??Initialized with base URL: ${this.baseUrl}`);
        log.info(`[ApiService] ?占쏙옙 Environment: ${typeof window !== 'undefined' ? window.location.hostname : 'server-side'}`);
        return true;
    }
    
    /**
     * Firebase ID ?占쏀겙 媛?占쎌삤占?     */
    async getAuthToken() {
        // getRealAuthUser()瑜??ъ슜?섏뿬 ?ㅼ젣 Firebase ?ъ슜??媛앹껜 媛?몄삤湲?       
        const user = firebaseService.getRealAuthUser();
        if (!user) {
            throw new Error('User not authenticated');
        }
        // Firebase ?ъ슜??媛앹껜?몄? ?뺤씤
        if (typeof user.getIdToken !== 'function') {
            log.error('[ApiService] getAuthToken - user is not a valid Firebase user object:', user);
            throw new Error('Invalid user object - getIdToken is not a function');
        }
        return await user.getIdToken();
    }
    
    /**
     * API ?占쎌껌 ?占쏀띁
     */
    async request(endpoint, options = {}) {
        await this.initialize();
        
        const url = `${this.baseUrl}${endpoint}`;
        
        // ⚡ 디버깅: 요청 URL 로그
        console.log(`[ApiService] 🔍 Making request: ${url}`, { method: options.method || 'GET', endpoint });
        
        // ⚠️ 엔드포인트 등급 확인: 공개 vs 인증 필수
        const isPublicEndpoint = this.isPublicEndpoint(endpoint);
        const isAuthRequired = this.isAuthRequiredEndpoint(endpoint);
        
        // 선택적 인증: 공개 엔드포인트는 인증 없이도 접근 가능
        let token = null;
        if (isAuthRequired) {
            // 인증 필수 엔드포인트는 반드시 토큰 필요
            token = await this.getAuthToken();
        } else {
            // 공개 엔드포인트는 선택적 인증
            try {
                token = await this.getAuthToken();
            } catch (error) {
                // 사용자가 로그인하지 않은 경우 (공개 엔드포인트는 허용)
                if (error.message === 'User not authenticated' || error.message.includes('not authenticated')) {
                    log.debug(`[ApiService] No authentication token for ${endpoint} (public endpoint)`);
                } else {
                    throw error;
                }
            }
        }
        
        const defaultOptions = {
            headers: {
                'Content-Type': 'application/json',
            },
        };
        
        // 토큰이 있으면 Authorization 헤더 추가
        if (token) {
            defaultOptions.headers['Authorization'] = `Bearer ${token}`;
        }
        
        const finalOptions = {
            ...defaultOptions,
            ...options,
            headers: {
                ...defaultOptions.headers,
                ...(options.headers || {}),
            },
        };
        
        // ?占?占쎌븘???占쎌젙 (湲곕낯 30占?
        const timeout = options.timeout || 30000;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        
        try {
            log.debug(`[ApiService] ${finalOptions.method || 'GET'} ${url}`);
            console.log(`[ApiService] 🔍 Making request: ${url}`, { 
                method: finalOptions.method || 'GET',
                hasAuth: !!token,
                endpoint 
            });
            
            const response = await fetch(url, {
                ...finalOptions,
                signal: controller.signal
            });
            
            console.log(`[ApiService] ✅ Response received: ${response.status} ${response.statusText} for ${url}`);
            
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                // HTTP 상태 코드에 따른 정확한 에러 메시지 매핑
                const status = response.status;
                let errorMessage = 'Unknown error';
                let errorDetails = null;
                
                // ⚠️ 서버 응답 본문 읽기 시도 (에러 상세 정보 추출)
                try {
                    const responseText = await response.clone().text();
                    console.log(`🔍 [ApiService] Server error response body:`, responseText);
                    
                    try {
                        const errorData = JSON.parse(responseText);
                        console.log(`🔍 [ApiService] Parsed error data:`, errorData);
                        
                        // 다양한 에러 메시지 필드 확인
                        errorMessage = errorData.error || 
                                      errorData.message || 
                                      errorData.detail || 
                                      errorData.errorMessage ||
                                      errorData.msg ||
                                      `HTTP ${status}`;
                        
                        errorDetails = {
                            ...errorData,
                            rawResponse: responseText
                        };
                        
                        // ⚠️ DB 스키마 에러 감지 및 특별 처리
                        const errorText = (errorMessage + ' ' + responseText).toLowerCase();
                        const isSchemaError = errorText.includes('does not exist') || 
                                            (errorText.includes('column') && errorText.includes('relation')) ||
                                            errorText.includes('missing column') ||
                                            errorText.includes('unknown column') ||
                                            errorText.includes('no such column');
                        
                        if (isSchemaError) {
                            console.error(`🔴 [ApiService] ⚠️ DB SCHEMA MISMATCH DETECTED!`);
                            console.error(`🔴 [ApiService] This is a backend database schema issue, not a frontend problem.`);
                            console.error(`🔴 [ApiService] Error:`, errorMessage);
                            console.error(`🔴 [ApiService] Full response:`, responseText);
                            
                            // DB 스키마 에러 플래그 추가
                            errorDetails.isSchemaError = true;
                            errorDetails.schemaError = {
                                detected: true,
                                message: 'Database schema mismatch detected. Backend is trying to access a column that does not exist in the database.',
                                recommendation: 'Please check backend database migrations and ensure all required columns exist.',
                                commonSolution: 'Run database migrations or add the missing column to the database.'
                            };
                        }
                        
                        // 서버가 제공한 상세 에러 정보가 있으면 로깅
                        if (errorData.stack) {
                            console.log(`🔍 [ApiService] Server error stack:`, errorData.stack);
                        }
                        if (errorData.details) {
                            console.log(`🔍 [ApiService] Server error details:`, errorData.details);
                        }
                        if (errorData.cause) {
                            console.log(`🔍 [ApiService] Server error cause:`, errorData.cause);
                        }
                    } catch (jsonError) {
                        // JSON이 아니면 텍스트 그대로 사용
                        console.log(`🔍 [ApiService] Error response is not JSON, using raw text`);
                        errorMessage = responseText || `HTTP ${status}`;
                        errorDetails = { rawResponse: responseText };
                    }
                } catch (readError) {
                    // 응답 본문 읽기 실패 시 상태 코드 기반 메시지
                    console.log(`🔍 [ApiService] Failed to read error response body:`, readError);
                    if (status === 500) {
                        errorMessage = 'Server error';
                    } else if (status === 401 || status === 403) {
                        errorMessage = status === 401 ? 'Authentication required' : 'Permission denied';
                    } else if (status === 404) {
                        errorMessage = 'Not found';
                    } else {
                        errorMessage = `HTTP ${status}`;
                    }
                }
                
                // 상태 코드별 에러 메시지 정확히 매핑
                if (status === 500) {
                    errorMessage = errorMessage || 'Server error';
                } else if (status === 401) {
                    errorMessage = 'Authentication required';
                } else if (status === 403) {
                    errorMessage = 'Permission denied';
                } else if (status === 404) {
                    errorMessage = 'Not found';
                }
                
                // ⚠️ 500 에러 상세 로깅
                if (status === 500) {
                    log.error(`[ApiService] HTTP 500 error: ${url}`, {
                        errorMessage,
                        errorDetails,
                        url
                    });
                }
                
                const httpError = new Error(errorMessage);
                httpError.status = status;
                httpError.details = errorDetails;
                httpError.response = response; // 원본 응답 보관 (나중에 파싱 가능하도록)
                throw httpError;
            }
            
            return await response.json();
        } catch (error) {
            clearTimeout(timeoutId);
            
            // 이미 HTTP 상태 코드가 있는 에러는 그대로 전달
            if (error.status) {
                // 409 Conflict는 정상적인 상황일 수 있으므로 조용히 처리
                if (error.status === 409) {
                    log.debug(`[ApiService] HTTP 409 Conflict (expected in some cases): ${endpoint}`, { url, error: error.message });
                } else {
                    log.error(`[ApiService] HTTP ${error.status} error: ${endpoint}`, { url, error: error.message });
                }
                throw error;
            }
            
            // 타임아웃 에러 처리
            if (error.name === 'AbortError') {
                const timeoutError = new Error('Request timeout - server may be offline');
                log.error(`[ApiService] Request timeout: ${endpoint}`, { url, timeout });
                throw timeoutError;
            }
            
            // 네트워크 연결 에러만 "Connection refused"로 매핑
            // (fetch 자체가 실패한 경우만, HTTP 500은 제외)
            if (error.message?.includes('Failed to fetch') || 
                error.message?.includes('NetworkError') ||
                error.message?.includes('ERR_CONNECTION_REFUSED') ||
                error.message?.includes('ERR_CONNECTION_RESET') ||
                error.message?.includes('ERR_NETWORK_CHANGED')) {
                const connectionError = new Error('Connection refused - server may be offline');
                log.error(`[ApiService] Connection error: ${endpoint}`, { url, error: error.message });
                throw connectionError;
            }
            
            log.error(`[ApiService] Request failed: ${endpoint}`, error);
            throw error;
        }
    }
    
    /**
     * GET ?占쎌껌
     */
    async get(endpoint) {
        return await this.request(endpoint, { method: 'GET' });
    }
    
    /**
     * POST ?占쎌껌
     */
    async post(endpoint, data) {
        return await this.request(endpoint, {
            method: 'POST',
            body: JSON.stringify(data),
        });
    }
    
    /**
     * PUT ?占쎌껌
     */
    async put(endpoint, data) {
        return await this.request(endpoint, {
            method: 'PUT',
            body: JSON.stringify(data),
        });
    }
    
    /**
     * DELETE ?占쎌껌
     */
    async delete(endpoint) {
        return await this.request(endpoint, { method: 'DELETE' });
    }
    
    // ============================================
    // 占?API
    // ============================================
    
    /**
     * 占??占쎈깄??議고쉶
     */
    async getMapSnapshot() {
        return await this.get('/map/snapshot');
    }
    
    // ============================================
    // ?占쏀넗 API
    // ============================================
    
    /**
     * ?占쏀넗 ?占쎌꽭 議고쉶
     */

    /**
     * 영토 목록 조회
     */
    /**
     * 영토 목록 조회
     * @param {Object} params - 쿼리 파라미터
     * @param {string} params.country - 국가 필터
     * @param {string} params.status - 상태 필터
     * @param {number} params.limit - 제한 개수
     * @param {string|string[]} params.fields - 반환할 필드 목록 (쉼표로 구분 또는 배열)
     * @returns {Promise<Array>} 영토 목록
     */
    async getTerritories(params = {}) {
        // ⚡ 성능 최적화: fields가 배열이면 쉼표로 구분된 문자열로 변환
        const queryParams = { ...params };
        if (Array.isArray(queryParams.fields)) {
            queryParams.fields = queryParams.fields.join(',');
        }
        
        const queryString = new URLSearchParams(queryParams).toString();
        const endpoint = queryString ? `/territories?${queryString}` : '/territories';
        return await this.get(endpoint);
    }
    
    /**
     * 영토 상세 조회
     * @param {string} id - Territory ID
     * @param {object} options - 옵션
     * @param {boolean} options.skipCache - 캐시 우회 (reconcile 시 사용)
     */
    async getTerritory(id, options = {}) {
        const { skipCache = false } = options;
        let endpoint = `/territories/${id}`;
        
        // 캐시 우회 옵션이 있으면 쿼리 파라미터 추가
        if (skipCache) {
            endpoint += '?skipCache=true';
        }
        
        // 또는 헤더로 전달 (더 명확함)
        const headers = skipCache ? { 'X-Skip-Cache': 'true' } : {};
        
        const territory = await this.request(endpoint, { 
            method: 'GET',
            headers
        });
        
        // ⚠️ 디버깅: API 응답에 countryIso가 포함되어 있는지 확인
        console.log(`[ApiService] 🔍 Territory response for ${id}:`, {
            id: territory?.id,
            country: territory?.country,
            countryIso: territory?.countryIso,
            country_iso: territory?.country_iso,
            hasCountryIso: !!territory?.countryIso,
            keys: Object.keys(territory || {}).slice(0, 20) // 처음 20개 키만
        });
        
        return territory;
    }
    
    /**
     * ?占쏀넗???占쎌꽦 寃쎈ℓ 議고쉶
     */
    async getTerritoryActiveAuction(territoryId) {
        return await this.get(`/territories/${territoryId}/auctions/active`);
    }
    
    /**
     * ?곹넗 ?낅뜲?댄듃 (?뚯쑀沅?蹂寃? ?곹깭 蹂寃???
     */
    async updateTerritory(territoryId, data) {
        try {
            return await this.put(`/territories/${territoryId}`, data);
        } catch (error) {
            // 409 Conflict는 이미 소유된 영토이므로 정상적인 상황 (조용히 무시)
            if (error.status === 409) {
                const errorMessage = error.message || error.details?.error || '';
                if (errorMessage.includes('already owned')) {
                    log.debug(`[ApiService] Territory ${territoryId} already owned, skipping update`);
                    return null; // 조용히 성공으로 처리
                }
            }
            throw error; // 다른 에러는 그대로 전달
        }
    }
    
    /**
     * ?곹넗 援щℓ (?꾨Ц媛 議곗뼵: ?먯옄??蹂댁옣 - ?ъ씤??李④컧怨??뚯쑀沅?遺?щ? ?섎굹???몃옖??뀡?쇰줈)
     */
    async purchaseTerritory(territoryId, data) {
        // ⚠️ 요청 데이터 검증 및 로깅
        console.log(`🔍 [ApiService] ========== purchaseTerritory START ==========`);
        console.log(`🔍 [ApiService] Request data:`, {
            territoryId,
            price: data?.price,
            protectionDays: data?.protectionDays,
            purchasedByAdmin: data?.purchasedByAdmin,
            dataKeys: Object.keys(data || {}),
            fullData: JSON.stringify(data, null, 2)
        });
        
        // 요청 데이터 검증
        if (!territoryId) {
            const error = new Error('Territory ID is required');
            log.error(`[ApiService] ❌ purchaseTerritory validation failed:`, error);
            throw error;
        }
        
        if (!data || typeof data !== 'object') {
            const error = new Error('Purchase data is required');
            log.error(`[ApiService] ❌ purchaseTerritory validation failed:`, error);
            throw error;
        }
        
        if (data.price === undefined || data.price === null || isNaN(data.price)) {
            const error = new Error('Price is required and must be a number');
            log.error(`[ApiService] ❌ purchaseTerritory validation failed:`, error);
            throw error;
        }
        
        log.info(`[ApiService] 🛒 purchaseTerritory called:`, { territoryId, data });
        
        try {
            const result = await this.post(`/territories/${territoryId}/purchase`, data);
            console.log(`🔍 [ApiService] ✅ purchaseTerritory success:`, result);
            log.info(`[ApiService] ✅ purchaseTerritory success:`, result);
            return result;
        } catch (error) {
            // ⚠️ 에러 상세 로깅
            console.log(`🔍 [ApiService] ❌ purchaseTerritory failed:`, {
                territoryId,
                data,
                error: error.message,
                errorStatus: error.status,
                errorDetails: error.details,
                errorStack: error.stack
            });
            
            log.error(`[ApiService] ❌ purchaseTerritory failed:`, {
                territoryId,
                data,
                error: error.message,
                errorStatus: error.status,
                errorDetails: error.details,
                stack: error.stack
            });
            throw error;
        }
    }
    
    /**
     * ?쎌? ?곗씠?????     */
    /**
     * 픽셀 데이터 저장
     * @param {string} territoryId - Territory ID
     * @param {object} pixelData - 픽셀 데이터
     * @param {object} options - 옵션
     * @param {string} options.saveRunId - 저장 실행 ID (진단용)
     */
    async savePixelData(territoryId, pixelData, options = {}) {
        const headers = {};
        if (options.saveRunId) {
            headers['x-save-run-id'] = options.saveRunId;
        }
        return await this.post(`/territories/${territoryId}/pixels`, pixelData, { headers });
    }
    
    /**
     * ?쎌? ?곗씠??議고쉶
     */
    async getPixelData(territoryId) {
        return await this.get(`/territories/${territoryId}/pixels`);
    }
    
    // ============================================
    // 寃쎈ℓ API
    // ============================================
    
    /**
     * 寃쎈ℓ ?占쎌꽭 議고쉶
     */
    async getAuction(id) {
        return await this.get(`/auctions/${id}`);
    }
    
    /**
     * 입찰 제출
     */
    async placeBid(auctionId, amount) {
        // ⚠️ 디버깅 로그: API 호출 직전 payload 확인 (가장 중요)
        const payload = { amount };
        console.log('[Bid] PAYLOAD amount', payload.amount, payload, {
            amount,
            amountType: typeof amount,
            auctionId
        });
        
        const result = await this.post(`/auctions/${auctionId}/bids`, payload);
        
        // ?占쎈떟 ?占쎌떇 蹂??(?占쏀솚??
        if (result.bid) {
            return {
                ...result.bid,
                amount: result.bid.amount || amount,
                auctionId: result.bid.auction_id || auctionId,
            };
        }
        return result;
    }
    
    /**
     * 경매 종료
     * ⚠️ 전문가 조언 반영: Firestore runTransaction 대신 API 사용
     */
    async endAuction(auctionId) {
        return await this.post(`/auctions/${auctionId}/end`, {});
    }
    
    /**
     * ?占쎌꽦 寃쎈ℓ 紐⑸줉 議고쉶
     */
    async getActiveAuctions(options = {}) {
        const { country, season, limit } = options;
        let url = '/auctions?status=active';
        if (country) url += `&country=${country}`;
        if (season) url += `&season=${season}`;
        if (limit) url += `&limit=${limit}`;
        return await this.get(url);
    }
    
    /**
     * 경매 생성
     * @param {Object} payload - 경매 생성 데이터
     * @param {string} payload.territoryId - Territory ID
     * @param {number} payload.startingBid - 시작 입찰가
     * @param {number} payload.minBid - 최소 입찰가
     * @param {string} payload.endTime - 종료 시간 (ISO 8601)
     * @param {number|null} payload.protectionDays - 보호 기간 (선택)
     * @param {string} payload.type - 경매 타입 (standard | protection_extension)
     * @returns {Promise<Object>} 생성된 경매 정보
     */
    async createAuction(payload) {
        return await this.post('/auctions', payload);
    }
    
    /**
     * 경매 업데이트
     * @param {string} auctionId - 경매 ID
     * @param {Object} data - 업데이트할 데이터
     * @returns {Promise<Object>} 업데이트된 경매 정보
     */
    async updateAuction(auctionId, data) {
        return await this.put(`/auctions/${auctionId}`, data);
    }
    
    // ============================================
    // ?占쎌슜??API
    // ============================================
    
    /**
     * ?占쎌옱 ?占쎌슜???占쎈낫 議고쉶
     */
    async getCurrentUser() {
        return await this.get('/users/me');
    }
    
    /**
     * ?占쎌옱 ?占쎌슜??吏占?議고쉶
     */
    async getWallet() {
        return await this.get('/users/me/wallet');
    }
    
    /**
     * 吏媛??낅뜲?댄듃 (?붿븸 蹂寃? 嫄곕옒 ?댁뿭 異붽?)
     */
    async updateWallet(balance, transaction = null) {
        return await this.put('/users/me/wallet', {
            balance: balance,
            transaction: transaction
        });
    }
    
    /**
     * 엔드포인트가 공개 엔드포인트인지 확인
     * 
     * @param {string} endpoint - 엔드포인트 경로
     * @returns {boolean}
     */
    isPublicEndpoint(endpoint) {
        // PUBLIC_ENDPOINTS가 정의되어 있지 않으면 false
        if (!this.PUBLIC_ENDPOINTS || !Array.isArray(this.PUBLIC_ENDPOINTS)) {
            return false;
        }
        
        // 정확한 매칭 또는 prefix 매칭
        return this.PUBLIC_ENDPOINTS.some(pattern => {
            // 정확한 매칭
            if (endpoint === pattern) {
                return true;
            }
            // prefix 매칭 (예: '/territories'는 '/territories/123'과 매칭)
            if (endpoint.startsWith(pattern + '/')) {
                return true;
            }
            // 패턴 매칭 (간단한 구현) - :id 같은 파라미터 처리
            try {
                const regexPattern = '^' + pattern.replace(/:[^/]+/g, '[^/]+') + '$';
                const regex = new RegExp(regexPattern);
                return regex.test(endpoint);
            } catch (e) {
                return false;
            }
        });
    }
    
    /**
     * 엔드포인트가 인증 필수인지 확인
     * 
     * @param {string} endpoint - 엔드포인트 경로
     * @returns {boolean}
     */
    isAuthRequiredEndpoint(endpoint) {
        // AUTH_REQUIRED_ENDPOINTS가 정의되어 있지 않으면 기본 규칙 사용
        if (!this.AUTH_REQUIRED_ENDPOINTS || !Array.isArray(this.AUTH_REQUIRED_ENDPOINTS)) {
            // 기본적으로 /users/me, /purchase, /bids, /admin 등은 인증 필요
            // ⚡ /pixels는 PUBLIC_ENDPOINTS에 포함되어 있으므로 제외
            return endpoint.includes('/users/me') || 
                   endpoint.includes('/purchase') || 
                   endpoint.includes('/bids') ||
                   endpoint.includes('/admin');
        }
        
        // prefix 매칭 (예: '/users/me'는 '/users/me/wallet'과 매칭)
        return this.AUTH_REQUIRED_ENDPOINTS.some(pattern => {
            if (endpoint.startsWith(pattern)) {
                return true;
            }
            // 패턴 매칭 (간단한 구현)
            try {
                const regexPattern = '^' + pattern.replace(/:[^/]+/g, '[^/]+') + '$';
                const regex = new RegExp(regexPattern);
                return regex.test(endpoint);
            } catch (e) {
                return false;
            }
        });
    }
}

// ?占쏙옙????占쎌뒪?占쎌뒪
export const apiService = new ApiService();


