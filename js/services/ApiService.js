/**
 * ApiService - 백엔드 REST API 클라이언트
 * Firestore 대신 새로운 백엔드 API를 사용
 */

import { CONFIG, log } from '../config.js';
import { firebaseService } from './FirebaseService.js';
import { eventBus, EVENTS } from '../core/EventBus.js';

class ApiService {
    constructor() {
        this.baseUrl = CONFIG.API_BASE_URL || 'http://localhost:3000/api';
        this.initialized = false;
    }
    
    /**
     * 초기화
     */
    async initialize() {
        if (this.initialized) {
            return true;
        }
        
        // 환경에 따라 API URL 설정
        if (CONFIG.API_BASE_URL) {
            this.baseUrl = CONFIG.API_BASE_URL;
        } else if (typeof window !== 'undefined') {
            // 프로덕션 환경 자동 감지
            const hostname = window.location.hostname;
            if (hostname.includes('netlify') || hostname.includes('vercel') || hostname.includes('railway')) {
                // 프로덕션 백엔드 URL 설정
                this.baseUrl = 'https://global-advertising-platform-production.up.railway.app/api';
            }
        }
        
        this.initialized = true;
        log.info(`[ApiService] ✅ Initialized with base URL: ${this.baseUrl}`);
        return true;
    }
    
    /**
     * Firebase ID 토큰 가져오기
     * ✅ 단일 경로로 통일: firebaseService.auth.currentUser에서만 토큰 가져오기
     */
    async getAuthToken() {
        // ✅ 단일 Firebase 인스턴스 사용: firebaseService.auth.currentUser만 사용
        if (!firebaseService.auth) {
            log.error('[ApiService] ❌ firebaseService.auth is null');
            throw new Error('User not authenticated - Firebase Auth not initialized');
        }
        
        if (!firebaseService.auth.currentUser) {
            log.error('[ApiService] ❌ firebaseService.auth.currentUser is null', {
                authExists: !!firebaseService.auth,
                currentUser: firebaseService.auth.currentUser,
                firebaseServiceCurrentUser: firebaseService.getCurrentUser()
            });
            throw new Error('User not authenticated - No current user');
        }
        
        const user = firebaseService.auth.currentUser;
        log.info('[ApiService] 🔍 Getting token for user:', {
            email: user.email,
            uid: user.uid,
            hasGetIdToken: typeof user.getIdToken === 'function'
        });
        
        try {
            // ✅ 강제로 새 토큰 가져오기 (forceRefresh: true)
            // 토큰이 만료되었거나 캐시된 토큰이 있을 수 있으므로 강제로 새로 가져옴
            const token = await user.getIdToken(true);
            
            // ✅ 토큰 디코딩하여 정보 확인 (디버깅용)
            try {
                const tokenParts = token.split('.');
                if (tokenParts.length === 3) {
                    const payload = JSON.parse(atob(tokenParts[1]));
                    const isExpired = Date.now() > payload.exp * 1000;
                    const projectMatch = payload.aud === CONFIG.FIREBASE.projectId;
                    
                    // ✅ 토큰 정보를 명확하게 출력
                    console.log('[ApiService] ✅ Token obtained successfully');
                    console.log('[ApiService] Token Info:', {
                        tokenLength: token.length,
                        userEmail: user.email,
                        tokenIss: payload.iss,
                        tokenAud: payload.aud,
                        expectedAud: CONFIG.FIREBASE.projectId,
                        projectMatch: projectMatch,
                        tokenExp: payload.exp,
                        tokenIat: payload.iat,
                        expDate: new Date(payload.exp * 1000).toISOString(),
                        now: new Date().toISOString(),
                        isExpired: isExpired,
                        email: payload.email,
                        uid: payload.uid
                    });
                    
                    log.info('[ApiService] ✅ Token obtained successfully', {
                        tokenLength: token.length,
                        tokenPreview: token.substring(0, 50) + '...',
                        userEmail: user.email,
                        tokenPayload: {
                            iss: payload.iss,
                            aud: payload.aud,
                            expectedAud: CONFIG.FIREBASE.projectId,
                            projectMatch: projectMatch,
                            exp: payload.exp,
                            iat: payload.iat,
                            email: payload.email,
                            uid: payload.uid,
                            expDate: new Date(payload.exp * 1000).toISOString(),
                            now: new Date().toISOString(),
                            isExpired: isExpired
                        }
                    });
                    
                    // ✅ 프로젝트 불일치 경고
                    if (!projectMatch) {
                        console.error('[ApiService] ❌ PROJECT MISMATCH!', {
                            tokenAud: payload.aud,
                            expectedAud: CONFIG.FIREBASE.projectId,
                            tokenIss: payload.iss
                        });
                        log.error('[ApiService] ❌ PROJECT MISMATCH!', {
                            tokenAud: payload.aud,
                            expectedAud: CONFIG.FIREBASE.projectId,
                            tokenIss: payload.iss
                        });
                    }
                    
                    // ✅ 토큰 만료 경고
                    if (isExpired) {
                        console.error('[ApiService] ❌ TOKEN EXPIRED!', {
                            expDate: new Date(payload.exp * 1000).toISOString(),
                            now: new Date().toISOString()
                        });
                        log.error('[ApiService] ❌ TOKEN EXPIRED!', {
                            expDate: new Date(payload.exp * 1000).toISOString(),
                            now: new Date().toISOString()
                        });
                    }
                }
            } catch (decodeError) {
                log.warn('[ApiService] Failed to decode token for debugging:', decodeError);
            }
            
            return token;
        } catch (tokenError) {
            log.error('[ApiService] ❌ Failed to get token:', {
                error: tokenError,
                message: tokenError.message,
                code: tokenError.code,
                userEmail: user.email,
                userUid: user.uid
            });
            throw new Error(`Failed to get token: ${tokenError.message}`);
        }
    }
    
    /**
     * API 요청 헬퍼
     * @param {string} endpoint - API 엔드포인트
     * @param {object} options - 요청 옵션
     * @param {boolean} options.requireAuth - 인증 필수 여부 (기본값: true)
     */
    async request(endpoint, options = {}) {
        await this.initialize();
        
        const url = `${this.baseUrl}${endpoint}`;
        const requireAuth = options.requireAuth !== false; // 기본값: true (기존 호환성 유지)
        
        // 토큰 가져오기 (requireAuth가 false이면 시도만 하고 실패해도 계속 진행)
        let token = null;
        if (requireAuth) {
            try {
                token = await this.getAuthToken();
            } catch (error) {
                // requireAuth가 true인데 토큰을 가져올 수 없으면 에러 발생
                log.error(`[ApiService] ❌ Auth required but token unavailable for ${endpoint}:`, error.message);
                throw error;
            }
        } else {
            // Public API: 토큰이 있으면 사용, 없어도 계속 진행
            // 먼저 사용자가 있는지 확인 (에러 로그 방지)
            if (firebaseService.auth && firebaseService.auth.currentUser) {
                try {
                    token = await this.getAuthToken();
                    log.debug(`[ApiService] 🔓 Public API ${endpoint}: Token available (optional)`);
                } catch (error) {
                    log.debug(`[ApiService] 🔓 Public API ${endpoint}: Failed to get token, continuing without auth`);
                    token = null;
                }
            } else {
                log.debug(`[ApiService] 🔓 Public API ${endpoint}: No user, proceeding without token (guest mode)`);
                token = null;
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
        
        // requireAuth 옵션은 fetch에 전달하지 않음
        delete finalOptions.requireAuth;
        
        // ⚡ 타임아웃 추가 (2초) - 연결 거부 시 빠르게 실패 처리
        const timeoutMs = 2000; // 2초
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        
        try {
            log.debug(`[ApiService] ${finalOptions.method || 'GET'} ${url}`, {
                requireAuth,
                hasToken: !!token,
                tokenLength: token ? token.length : 0,
                tokenPreview: token ? token.substring(0, 30) + '...' : 'none'
            });
            const response = await fetch(url, {
                ...finalOptions,
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
                
                // ✅ 401 오류 시 상세 정보 로깅
                if (response.status === 401) {
                    console.error('[ApiService] ❌ 401 Unauthorized - Full Error Details:', {
                        endpoint,
                        error: errorData.error,
                        errorType: errorData.errorType,
                        errorCode: errorData.errorCode,
                        errorName: errorData.errorName,
                        details: errorData.details,
                        debug: errorData.debug,
                        tokenSent: !!token,
                        tokenLength: token ? token.length : 0
                    });
                    
                    // ✅ AUTH_INIT_ERROR인 경우 특별히 강조
                    if (errorData.errorCode === 'AUTH_INIT_ERROR') {
                        console.error('[ApiService] ⚠️⚠️⚠️ CRITICAL: Backend Firebase Admin SDK initialization failed!');
                        console.error('[ApiService] This is NOT a token problem - the backend cannot verify tokens.');
                        console.error('[ApiService] Please check the backend server terminal logs for the original error.');
                        if (errorData.debug) {
                            console.error('[ApiService] Backend error details:', errorData.debug);
                        }
                    }
                    log.error('[ApiService] ❌ 401 Unauthorized', {
                        endpoint,
                        error: errorData.error,
                        errorType: errorData.errorType,
                        errorCode: errorData.errorCode,
                        errorName: errorData.errorName,
                        details: errorData.details,
                        debug: errorData.debug,
                        tokenSent: !!token,
                        tokenLength: token ? token.length : 0
                    });
                }
                
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }
            
            return await response.json();
        } catch (error) {
            clearTimeout(timeoutId);
            
            // ⚡ 연결 거부 오류를 빠르게 감지하고 조용히 처리 (API 서버가 없을 때)
            if (error.name === 'AbortError') {
                log.debug(`[ApiService] Request timeout: ${endpoint} (server may be offline)`);
                throw new Error('Request timeout - server may be offline');
            } else if (error.message && (error.message.includes('Failed to fetch') || error.message.includes('ERR_CONNECTION_REFUSED') || error.message.includes('NetworkError'))) {
                log.debug(`[ApiService] Connection refused: ${endpoint} (server may be offline)`);
                throw new Error('Connection refused - server may be offline');
            }
            
            log.error(`[ApiService] Request failed: ${endpoint}`, error);
            throw error;
        }
    }
    
    /**
     * GET 요청
     * @param {string} endpoint - API 엔드포인트
     * @param {object} options - 요청 옵션
     * @param {boolean} options.requireAuth - 인증 필수 여부 (기본값: true)
     */
    async get(endpoint, options = {}) {
        return await this.request(endpoint, { method: 'GET', ...options });
    }
    
    /**
     * POST 요청
     */
    async post(endpoint, data) {
        return await this.request(endpoint, {
            method: 'POST',
            body: JSON.stringify(data),
        });
    }
    
    /**
     * PUT 요청
     */
    async put(endpoint, data) {
        return await this.request(endpoint, {
            method: 'PUT',
            body: JSON.stringify(data),
        });
    }
    
    /**
     * DELETE 요청
     */
    async delete(endpoint, data) {
        return await this.request(endpoint, {
            method: 'DELETE',
            body: data ? JSON.stringify(data) : undefined,
        });
    }
    
    // ============================================
    // 맵 API
    // ============================================
    
    /**
     * 맵 스냅샷 조회
     */
    async getMapSnapshot() {
        return await this.get('/map/snapshot');
    }
    
    // ============================================
    // 영토 API
    // ============================================
    
    /**
     * 영토 목록 조회 (Public API - 게스트 허용)
     */
    async getTerritories(options = {}) {
        const { country, status, limit } = options;
        let url = '/territories';
        const params = [];
        if (country) params.push(`country=${country}`);
        if (status) params.push(`status=${status}`);
        if (limit) params.push(`limit=${limit}`);
        if (params.length > 0) url += `?${params.join('&')}`;
        return await this.get(url, { requireAuth: false });
    }
    
    /**
     * 영토 상세 조회 (Public API - 게스트 허용)
     */
    async getTerritory(id) {
        return await this.get(`/territories/${id}`, { requireAuth: false });
    }
    
    /**
     * 영토 정보 업데이트 (소유권 변경, 상태 변경 등)
     */
    async updateTerritory(territoryId, data) {
        return await this.put(`/territories/${territoryId}`, data);
    }
    
    /**
     * 영토의 활성 경매 조회 (Public API - 게스트 허용)
     */
    async getTerritoryActiveAuction(territoryId) {
        return await this.get(`/territories/${territoryId}/auctions/active`, { requireAuth: false });
    }
    
    // ============================================
    // 경매 API
    // ============================================
    
    /**
     * 경매 상세 조회 (Public API - 게스트 허용)
     */
    async getAuction(id) {
        return await this.get(`/auctions/${id}`, { requireAuth: false });
    }
    
    /**
     * 입찰 생성
     */
    async placeBid(auctionId, amount) {
        const result = await this.post(`/auctions/${auctionId}/bids`, { amount });
        
        // 응답 형식 변환 (호환성)
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
     * 활성 경매 목록 조회
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
     */
    async createAuction(auctionData) {
        return await this.post('/auctions', auctionData);
    }
    
    /**
     * 경매 업데이트
     */
    async updateAuction(auctionId, updateData) {
        return await this.put(`/auctions/${auctionId}`, updateData);
    }
    
    // ============================================
    // 사용자 API
    // ============================================
    
    /**
     * 현재 사용자 정보 조회
     */
    async getCurrentUser() {
        return await this.get('/users/me');
    }
    
    /**
     * 현재 사용자 지갑 조회
     */
    async getWallet() {
        return await this.get('/users/me/wallet');
    }
    
    /**
     * 현재 사용자 지갑 업데이트
     */
    async updateWallet(balance, transaction = null) {
        return await this.put('/users/me/wallet', {
            balance,
            transaction
        });
    }
    
    /**
     * 현재 사용자 거래 내역 조회
     */
    async getWalletTransactions(options = {}) {
        const { limit = 50, offset = 0 } = options;
        let url = '/users/me/wallet/transactions';
        const params = [];
        if (limit) params.push(`limit=${limit}`);
        if (offset) params.push(`offset=${offset}`);
        if (params.length > 0) url += `?${params.join('&')}`;
        return await this.get(url);
    }
    
    // ============================================
    // 픽셀 데이터 API
    // ============================================
    
    /**
     * 영토의 픽셀 데이터 조회
     */
    async getPixelData(territoryId) {
        return await this.get(`/territories/${territoryId}/pixels`);
    }
    
    /**
     * 영토의 픽셀 데이터 저장
     */
    async savePixelData(territoryId, pixelData) {
        return await this.post(`/territories/${territoryId}/pixels`, pixelData);
    }
    
    /**
     * 영토의 픽셀 데이터 삭제 (소유권 이전 시)
     */
    async deletePixelData(territoryId) {
        return await this.delete(`/territories/${territoryId}/pixels`);
    }
    
    /**
     * 픽셀 데이터가 있는 영토 ID 목록 조회
     */
    async getTerritoriesWithPixels() {
        const result = await this.get('/pixels/territories');
        return result.territoryIds || [];
    }
    
    // ============================================
    // 랭킹 API
    // ============================================
    
    /**
     * 랭킹 목록 조회 (Public API - 게스트 허용)
     */
    async getRankings(options = {}) {
        const { type = 'global_coverage', limit = 100 } = options;
        let url = '/rankings';
        const params = [];
        if (type) params.push(`type=${type}`);
        if (limit) params.push(`limit=${limit}`);
        if (params.length > 0) url += `?${params.join('&')}`;
        return await this.get(url, { requireAuth: false });
    }
    
    /**
     * 특정 사용자 랭킹 조회
     */
    async getUserRanking(userId) {
        return await this.get(`/rankings/${userId}`);
    }
}

// 싱글톤 인스턴스
export const apiService = new ApiService();

