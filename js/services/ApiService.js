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
            '/auctions',              // 경매 목록 조회 (공개)
            '/auctions/:id',          // 경매 상세 조회 (공개)
            '/health',                // 헬스 체크
            '/map/snapshot'           // 맵 스냅샷 (공개)
        ];
        
        // ⚠️ 인증 필수 엔드포인트 (절대 optional auth가 섞이면 안 됨)
        this.AUTH_REQUIRED_ENDPOINTS = [
            '/territories/:id/purchase',  // 구매
            '/territories/:id/pixels',    // 픽셀 저장/조회
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
                this.baseUrl = 'https://global-advertising-platform-production.up.railway.app/api';
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
            
            const response = await fetch(url, {
                ...finalOptions,
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }
            
            return await response.json();
        } catch (error) {
            clearTimeout(timeoutId);
            
            // ?占쏀듃?占쏀겕 ?占쎈윭 泥섎━
            if (error.name === 'AbortError') {
                const timeoutError = new Error('Request timeout - server may be offline');
                log.error(`[ApiService] Request timeout: ${endpoint}`, { url, timeout });
                throw timeoutError;
            }
            
            // ?占쎄껐 嫄곤옙? ?占쎈윭 泥섎━
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
    async getTerritories(params = {}) {
        const queryString = new URLSearchParams(params).toString();
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
        
        return await this.request(endpoint, { 
            method: 'GET',
            headers
        });
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
        return await this.put(`/territories/${territoryId}`, data);
    }
    
    /**
     * ?곹넗 援щℓ (?꾨Ц媛 議곗뼵: ?먯옄??蹂댁옣 - ?ъ씤??李④컧怨??뚯쑀沅?遺?щ? ?섎굹???몃옖??뀡?쇰줈)
     */
    async purchaseTerritory(territoryId, data) {
        log.info(`[ApiService] ?썟 purchaseTerritory called:`, { territoryId, data });
        try {
            const result = await this.post(`/territories/${territoryId}/purchase`, data);
            log.info(`[ApiService] ??purchaseTerritory success:`, result);
            return result;
        } catch (error) {
            log.error(`[ApiService] ??purchaseTerritory failed:`, {
                territoryId,
                data,
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }
    
    /**
     * ?쎌? ?곗씠?????     */
    async savePixelData(territoryId, pixelData) {
        return await this.post(`/territories/${territoryId}/pixels`, pixelData);
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
     * ?占쎌같 ?占쎌꽦
     */
    async placeBid(auctionId, amount) {
        const result = await this.post(`/auctions/${auctionId}/bids`, { amount });
        
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
            // 기본적으로 /users/me, /purchase, /pixels 등은 인증 필요
            return endpoint.includes('/users/me') || 
                   endpoint.includes('/purchase') || 
                   endpoint.includes('/pixels') ||
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


