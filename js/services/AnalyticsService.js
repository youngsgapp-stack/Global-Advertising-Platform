/**
 * AnalyticsService - Google Analytics 통합 서비스
 * 이벤트 추적 및 사용자 행동 분석
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';

class AnalyticsService {
    constructor() {
        this.ga = null;
        this.initialized = false;
    }
    
    /**
     * 초기화
     */
    async initialize() {
        if (!CONFIG.ANALYTICS.ENABLED) {
            log.info('[Analytics] Analytics is disabled');
            return;
        }
        
        try {
            // Google Analytics 4 (gtag.js) 스크립트 동적 로드
            await this.loadGtagScript();
            
            // gtag 초기화
            if (typeof gtag !== 'undefined') {
                gtag('config', CONFIG.ANALYTICS.MEASUREMENT_ID, {
                    page_path: window.location.pathname,
                    send_page_view: CONFIG.ANALYTICS.TRACK_PAGE_VIEWS
                });
                
                this.initialized = true;
                log.info('[Analytics] Initialized successfully');
                
                // 이벤트 리스너 설정
                this.setupEventListeners();
            } else {
                log.warn('[Analytics] gtag not available');
            }
        } catch (error) {
            log.error('[Analytics] Initialization failed:', error);
        }
    }
    
    /**
     * Google Analytics 스크립트 로드
     */
    loadGtagScript() {
        return new Promise((resolve, reject) => {
            // 이미 로드되어 있는지 확인
            if (document.querySelector('script[src*="gtag"]')) {
                resolve();
                return;
            }
            
            // gtag 스크립트 추가
            const script = document.createElement('script');
            script.async = true;
            script.src = `https://www.googletagmanager.com/gtag/js?id=${CONFIG.ANALYTICS.MEASUREMENT_ID}`;
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
            
            // gtag 함수 정의
            window.dataLayer = window.dataLayer || [];
            window.gtag = function() {
                window.dataLayer.push(arguments);
            };
            gtag('js', new Date());
        });
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        if (!CONFIG.ANALYTICS.TRACK_EVENTS) return;
        
        // 로그인 이벤트
        eventBus.on(EVENTS.AUTH_STATE_CHANGED, ({ user }) => {
            if (user) {
                this.trackEvent('login', {
                    method: 'google',
                    user_id: user.uid
                });
            } else {
                this.trackEvent('logout');
            }
        });
        
        // 영토 구매
        eventBus.on(EVENTS.TERRITORY_CONQUERED, (data) => {
            this.trackEvent('territory_purchased', {
                territory_id: data.territoryId,
                price: data.price,
                method: data.method || 'instant'
            });
        });
        
        // 경매 입찰
        eventBus.on(EVENTS.AUCTION_BID_PLACED, (data) => {
            this.trackEvent('auction_bid', {
                territory_id: data.territoryId,
                bid_amount: data.bidAmount,
                auction_id: data.auctionId
            });
        });
        
        // 경매 낙찰
        eventBus.on(EVENTS.AUCTION_ENDED, (data) => {
            if (data.winner) {
                this.trackEvent('auction_won', {
                    territory_id: data.territoryId,
                    final_price: data.finalPrice,
                    auction_id: data.auctionId
                });
            }
        });
        
        // 결제 이벤트
        eventBus.on(EVENTS.PAYMENT_SUCCESS, (data) => {
            this.trackEvent('purchase', {
                transaction_id: data.orderID,
                value: data.amount,
                currency: data.currency || 'USD',
                items: [{
                    item_id: data.territoryId || 'points',
                    item_name: data.territoryId ? `Territory: ${data.territoryId}` : 'Points',
                    price: data.amount,
                    quantity: 1
                }]
            });
        });
        
        // 픽셀 편집기 사용
        eventBus.on(EVENTS.UI_MODAL_OPEN, (data) => {
            if (data.type === 'pixelEditor') {
                this.trackEvent('pixel_editor_opened', {
                    territory_id: data.data?.id
                });
            }
        });
        
        // 픽셀 저장
        eventBus.on(EVENTS.PIXEL_DATA_SAVED, () => {
            this.trackEvent('pixel_art_saved');
        });
    }
    
    /**
     * 이벤트 추적
     */
    trackEvent(eventName, eventParams = {}) {
        if (!this.initialized || typeof gtag === 'undefined') {
            return;
        }
        
        try {
            gtag('event', eventName, eventParams);
            log.debug(`[Analytics] Event tracked: ${eventName}`, eventParams);
        } catch (error) {
            log.error('[Analytics] Failed to track event:', error);
        }
    }
    
    /**
     * 페이지뷰 추적
     */
    trackPageView(pagePath, pageTitle = null) {
        if (!this.initialized || typeof gtag === 'undefined') {
            return;
        }
        
        try {
            gtag('config', CONFIG.ANALYTICS.MEASUREMENT_ID, {
                page_path: pagePath,
                page_title: pageTitle || document.title
            });
            log.debug(`[Analytics] Page view tracked: ${pagePath}`);
        } catch (error) {
            log.error('[Analytics] Failed to track page view:', error);
        }
    }
    
    /**
     * 사용자 속성 설정
     */
    setUserProperty(name, value) {
        if (!this.initialized || typeof gtag === 'undefined') {
            return;
        }
        
        try {
            gtag('set', { [name]: value });
        } catch (error) {
            log.error('[Analytics] Failed to set user property:', error);
        }
    }
    
    /**
     * 사용자 ID 설정
     */
    setUserId(userId) {
        if (!this.initialized || typeof gtag === 'undefined') {
            return;
        }
        
        try {
            gtag('config', CONFIG.ANALYTICS.MEASUREMENT_ID, {
                user_id: userId
            });
        } catch (error) {
            log.error('[Analytics] Failed to set user ID:', error);
        }
    }
}

export const analyticsService = new AnalyticsService();
export default analyticsService;

