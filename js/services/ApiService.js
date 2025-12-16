/**
 * ApiService - 백엔??REST API ?�라?�언?? * Firestore ?�???�로??백엔??API�??�용
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
     * 초기??     */
    async initialize() {
        if (this.initialized) {
            return true;
        }
        
        // ?�경???�라 API URL ?�정
        if (CONFIG.API_BASE_URL) {
            // config.js?�서 ?��? ?�정??URL ?�용
            this.baseUrl = CONFIG.API_BASE_URL;
        } else if (typeof window !== 'undefined') {
            // ?�로?�션 ?�경 ?�동 감�?
            const hostname = window.location.hostname;
            const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0';
            
            if (isLocalhost) {
                // 로컬 개발 ?�경
                this.baseUrl = 'http://localhost:3000/api';
            } else {
                // ?�로?�션 ?�경 (localhost가 ?�닌 모든 경우)
                this.baseUrl = 'https://global-advertising-platform-production.up.railway.app/api';
            }
        } else {
            // 기본�?(?�버 ?�이???�더�???
            this.baseUrl = 'http://localhost:3000/api';
        }
        
        this.initialized = true;
        log.info(`[ApiService] ??Initialized with base URL: ${this.baseUrl}`);
        log.info(`[ApiService] ?�� Environment: ${typeof window !== 'undefined' ? window.location.hostname : 'server-side'}`);
        return true;
    }
    
    /**
     * Firebase ID ?�큰 가?�오�?     */
    async getAuthToken() {
        const user = firebaseService.getCurrentUser();
        if (!user) {
            throw new Error('User not authenticated');
        }
        return await user.getIdToken();
    }
    
    /**
     * API ?�청 ?�퍼
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
        
        // ?�?�아???�정 (기본 30�?
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
            
            // ?�트?�크 ?�러 처리
            if (error.name === 'AbortError') {
                const timeoutError = new Error('Request timeout - server may be offline');
                log.error(`[ApiService] Request timeout: ${endpoint}`, { url, timeout });
                throw timeoutError;
            }
            
            // ?�결 거�? ?�러 처리
            if (error.message?.includes('Failed to fetch') || 
                error.message?.includes('NetworkError') ||
                error.message?.includes('ERR_CONNECTION_REFUSED') ||
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
     * GET ?�청
     */
    async get(endpoint) {
        return await this.request(endpoint, { method: 'GET' });
    }
    
    /**
     * POST ?�청
     */
    async post(endpoint, data) {
        return await this.request(endpoint, {
            method: 'POST',
            body: JSON.stringify(data),
        });
    }
    
    /**
     * PUT ?�청
     */
    async put(endpoint, data) {
        return await this.request(endpoint, {
            method: 'PUT',
            body: JSON.stringify(data),
        });
    }
    
    /**
     * DELETE ?�청
     */
    async delete(endpoint) {
        return await this.request(endpoint, { method: 'DELETE' });
    }
    
    // ============================================
    // �?API
    // ============================================
    
    /**
     * �??�냅??조회
     */
    async getMapSnapshot() {
        return await this.get('/map/snapshot');
    }
    
    // ============================================
    // ?�토 API
    // ============================================
    
    /**
     * ?�토 ?�세 조회
     */
    async getTerritory(id) {
        return await this.get(`/territories/${id}`);
    }
    
    /**
     * ?�토???�성 경매 조회
     */
    async getTerritoryActiveAuction(territoryId) {
        return await this.get(`/territories/${territoryId}/auctions/active`);
    }
    
    /**
     * 영토 업데이트 (소유권 변경, 상태 변경 등)
     */
    async updateTerritory(territoryId, data) {
        return await this.put(`/territories/${territoryId}`, data);
    }
    
    /**
     * 픽셀 데이터 저장
     */
    async savePixelData(territoryId, pixelData) {
        return await this.post(`/territories/${territoryId}/pixels`, pixelData);
    }
    
    /**
     * 픽셀 데이터 조회
     */
    async getPixelData(territoryId) {
        return await this.get(`/territories/${territoryId}/pixels`);
    }
    
    // ============================================
    // 경매 API
    // ============================================
    
    /**
     * 경매 ?�세 조회
     */
    async getAuction(id) {
        return await this.get(`/auctions/${id}`);
    }
    
    /**
     * ?�찰 ?�성
     */
    async placeBid(auctionId, amount) {
        const result = await this.post(`/auctions/${auctionId}/bids`, { amount });
        
        // ?�답 ?�식 변??(?�환??
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
     * ?�성 경매 목록 조회
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
    // ?�용??API
    // ============================================
    
    /**
     * ?�재 ?�용???�보 조회
     */
    async getCurrentUser() {
        return await this.get('/users/me');
    }
    
    /**
     * ?�재 ?�용??지�?조회
     */
    async getWallet() {
        return await this.get('/users/me/wallet');
    }
    
    /**
     * 지갑 업데이트 (잔액 변경, 거래 내역 추가)
     */
    async updateWallet(balance, transaction = null) {
        return await this.put('/users/me/wallet', {
            balance: balance,
            transaction: transaction
        });
    }
}

// ?��????�스?�스
export const apiService = new ApiService();

