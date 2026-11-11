/**
 * NotificationService - 브라우저 알림 서비스
 * 웹 푸시 알림 및 브라우저 알림 처리
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';

class NotificationService {
    constructor() {
        this.permission = null;
        this.notificationSupported = 'Notification' in window;
        this.serviceWorkerRegistration = null;
    }
    
    /**
     * 초기화
     */
    async initialize() {
        if (!this.notificationSupported) {
            log.warn('[NotificationService] Browser does not support notifications');
            return;
        }
        
        // 알림 권한 확인
        this.permission = Notification.permission;
        
        // Service Worker 등록 대기
        if ('serviceWorker' in navigator) {
            // 앱 시작을 막지 않도록 기다리지 않음 (서비스 워커 등록이 실패하면 ready가 끝나지 않음)
            navigator.serviceWorker.ready
                .then(registration => { this.serviceWorkerRegistration = registration; })
                .catch(error => log.error('[NotificationService] Service Worker not ready:', error));
        }
        
        // 이벤트 리스너 설정
        this.setupEventListeners();
        
        log.info('[NotificationService] Initialized with permission:', this.permission);
    }
    
    /**
     * 알림 권한 요청
     */
    async requestPermission() {
        if (!this.notificationSupported) {
            return false;
        }
        
        if (this.permission === 'granted') {
            return true;
        }
        
        try {
            const permission = await Notification.requestPermission();
            this.permission = permission;
            
            if (permission === 'granted') {
                log.info('[NotificationService] Notification permission granted');
                return true;
            } else {
                log.warn('[NotificationService] Notification permission denied');
                return false;
            }
        } catch (error) {
            log.error('[NotificationService] Failed to request permission:', error);
            return false;
        }
    }
    
    /**
     * 알림 표시
     */
    async showNotification(title, options = {}) {
        if (!this.notificationSupported) {
            log.warn('[NotificationService] Notifications not supported');
            return;
        }
        
        if (this.permission !== 'granted') {
            return;
        }
        
        const defaultOptions = {
            icon: '/og-image.png',
            tag: 'default',
            requireInteraction: false,
            silent: false,
            ...options
        };
        
        try {
            if (this.serviceWorkerRegistration) {
                // Service Worker를 통한 알림 (PWA)
                await this.serviceWorkerRegistration.showNotification(title, defaultOptions);
            } else {
                // 일반 브라우저 알림
                new Notification(title, defaultOptions);
            }
            
            log.debug('[NotificationService] Notification shown:', title);
        } catch (error) {
            log.error('[NotificationService] Failed to show notification:', error);
        }
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        // 경매 종료 알림
        eventBus.on(EVENTS.AUCTION_ENDED, async (data) => {
            const user = firebaseService?.getCurrentUser();
            if (!user || !data.winner || data.winner !== user.uid) return;
            
            await this.showNotification('🎉 You won the auction!', {
                body: `${data.territoryId} is yours now.`,
                tag: `auction-won-${data.auctionId}`,
                requireInteraction: true
            });
        });
        
        // 경매 새 입찰 알림
        eventBus.on(EVENTS.AUCTION_BID_PLACED, async (data) => {
            // 내가 입찰한 경매에서 다른 사람이 입찰했을 때만
            // (실시간 업데이트는 UI에서 처리)
        });
        
        // 영토 구매 완료
        eventBus.on(EVENTS.TERRITORY_CONQUERED, async (data) => {
            const user = firebaseService?.getCurrentUser();
            if (!user || data.ruler !== user.uid) return;
            
            await this.showNotification('✅ Spot claimed', {
                body: `${data.territoryId} is yours now.`,
                tag: `territory-conquered-${data.territoryId}`
            });
        });
        
        // 결제 완료
        eventBus.on(EVENTS.PAYMENT_SUCCESS, async (data) => {
            if (!data?.points) return;
            await this.showNotification('💰 Points added', {
                body: `${data.points} points were added to your wallet.`,
                tag: `payment-${data.orderID}`,
                requireInteraction: true
            });
        });
    }
    
    /**
     * 알림 권한 상태 확인
     */
    getPermissionStatus() {
        return this.permission || Notification.permission;
    }
    
    /**
     * 알림 권한이 있는지 확인
     */
    hasPermission() {
        return this.getPermissionStatus() === 'granted';
    }
}

// Firebase 서비스 임포트 (순환 참조 방지)
import { firebaseService } from './FirebaseService.js';

export const notificationService = new NotificationService();
export default notificationService;

