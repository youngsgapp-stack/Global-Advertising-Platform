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
     */
    async getAuthToken() {
        const user = firebaseService.getCurrentUser();
        if (!user) {
            throw new Error('User not authenticated');
        }
        return await user.getIdToken();
    }
    
    /**
     * API 요청 헬퍼
     */
    async request(endpoint, options = {}) {
        await this.initialize();
        
        const url = `${this.baseUrl}${endpoint}`;
        const token = await this.getAuthToken();
        
        const defaultOptions = {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
        };
        
        const finalOptions = {
            ...defaultOptions,
            ...options,
            headers: {
                ...defaultOptions.headers,
                ...(options.headers || {}),
            },
        };
        
        try {
            log.debug(`[ApiService] ${finalOptions.method || 'GET'} ${url}`);
            const response = await fetch(url, finalOptions);
            
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }
            
            return await response.json();
        } catch (error) {
            log.error(`[ApiService] Request failed: ${endpoint}`, error);
            throw error;
        }
    }
    
    /**
     * GET 요청
     */
    async get(endpoint) {
        return await this.request(endpoint, { method: 'GET' });
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
    async delete(endpoint) {
        return await this.request(endpoint, { method: 'DELETE' });
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
     * 영토 상세 조회
     */
    async getTerritory(id) {
        return await this.get(`/territories/${id}`);
    }
    
    /**
     * 영토의 활성 경매 조회
     */
    async getTerritoryActiveAuction(territoryId) {
        return await this.get(`/territories/${territoryId}/auctions/active`);
    }
    
    // ============================================
    // 경매 API
    // ============================================
    
    /**
     * 경매 상세 조회
     */
    async getAuction(id) {
        return await this.get(`/auctions/${id}`);
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
}

// 싱글톤 인스턴스
export const apiService = new ApiService();

