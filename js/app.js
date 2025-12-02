/**
 * Billionaire Homepage v2 - Main Application
 * 앱 진입점 및 초기화
 */

import { CONFIG, log } from './config.js';
import { eventBus, EVENTS } from './core/EventBus.js';
import { mapController } from './core/MapController.js';
import { territoryManager } from './core/TerritoryManager.js';
import { pixelCanvas } from './core/PixelCanvas.js';
import { firebaseService } from './services/FirebaseService.js';
import { auctionSystem } from './features/AuctionSystem.js';
import { rankingSystem } from './features/RankingSystem.js';
import { buffSystem } from './features/BuffSystem.js';
import { collaborationHub } from './features/CollaborationHub.js';
import { historyLogger } from './features/HistoryLogger.js';
import { territoryPanel } from './ui/TerritoryPanel.js';
import { pixelEditor } from './ui/PixelEditor.js';
import { rankingBoard } from './ui/RankingBoard.js';
import { timelineWidget } from './ui/TimelineWidget.js';

class BillionaireApp {
    constructor() {
        this.initialized = false;
        this.currentCountry = null;
    }
    
    /**
     * 앱 초기화
     */
    async init() {
        try {
            log.info(`${CONFIG.APP_NAME} v${CONFIG.VERSION} 초기화 시작...`);
            
            // 1. 로딩 표시
            this.showLoading();
            
            // 2. Firebase 초기화
            await firebaseService.initialize();
            
            // 3. 지도 초기화
            await mapController.initialize('map');
            
            // 4. 영토 관리자 초기화
            await territoryManager.initialize();
            
            // 5. 기능 시스템 초기화
            await Promise.all([
                auctionSystem.initialize(),
                rankingSystem.initialize(),
                buffSystem.initialize(),
                collaborationHub.initialize(),
                historyLogger.initialize()
            ]);
            
            // 6. UI 초기화
            territoryPanel.initialize();
            pixelEditor.initialize();
            rankingBoard.initialize();
            timelineWidget.initialize();
            this.initializeUI();
            
            // 7. 이벤트 리스너 설정
            this.setupEventListeners();
            
            // 8. 초기 데이터 로드
            await this.loadInitialData();
            
            // 9. 로딩 숨김
            this.hideLoading();
            
            this.initialized = true;
            log.info('앱 초기화 완료!');
            eventBus.emit(EVENTS.APP_READY, {});
            
        } catch (error) {
            log.error('앱 초기화 실패:', error);
            this.showError('앱을 시작할 수 없습니다. 페이지를 새로고침 해주세요.');
            eventBus.emit(EVENTS.APP_ERROR, { error });
        }
    }
    
    /**
     * UI 초기화
     */
    initializeUI() {
        // 국가 선택 드롭다운 초기화
        this.initCountrySelector();
        
        // 햄버거 메뉴 초기화
        this.initHamburgerMenu();
        
        // 별 배경 초기화
        this.initStarsBackground();
        
        // 키보드 단축키 설정
        this.setupKeyboardShortcuts();
    }
    
    /**
     * 국가 선택 드롭다운 초기화
     */
    initCountrySelector() {
        const selector = document.getElementById('country-selector');
        if (!selector) return;
        
        // G20 국가 옵션 추가
        for (const [code, country] of Object.entries(CONFIG.G20_COUNTRIES)) {
            const option = document.createElement('option');
            option.value = code;
            option.textContent = `${country.flag} ${country.nameKo}`;
            selector.appendChild(option);
        }
        
        // 변경 이벤트
        selector.addEventListener('change', (e) => {
            const countryCode = e.target.value;
            if (countryCode) {
                this.loadCountry(countryCode);
            }
        });
    }
    
    /**
     * 햄버거 메뉴 초기화
     */
    initHamburgerMenu() {
        const menuBtn = document.getElementById('hamburger-menu-btn');
        const sideMenu = document.getElementById('side-menu');
        const closeBtn = document.getElementById('close-side-menu');
        
        if (menuBtn && sideMenu) {
            menuBtn.addEventListener('click', () => {
                sideMenu.classList.toggle('hidden');
            });
        }
        
        if (closeBtn && sideMenu) {
            closeBtn.addEventListener('click', () => {
                sideMenu.classList.add('hidden');
            });
        }
        
        // 로그인/로그아웃 버튼
        const loginBtn = document.getElementById('side-user-login-btn');
        const logoutBtn = document.getElementById('side-user-logout-btn');
        
        if (loginBtn) {
            loginBtn.addEventListener('click', () => {
                firebaseService.signInWithGoogle();
            });
        }
        
        if (logoutBtn) {
            logoutBtn.addEventListener('click', () => {
                firebaseService.signOut();
            });
        }
    }
    
    /**
     * 별 배경 초기화
     */
    initStarsBackground() {
        const canvas = document.getElementById('stars-canvas');
        if (!canvas) return;
        
        const ctx = canvas.getContext('2d');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        
        // 별 생성
        const stars = [];
        const numStars = 200;
        
        for (let i = 0; i < numStars; i++) {
            stars.push({
                x: Math.random() * canvas.width,
                y: Math.random() * canvas.height,
                radius: Math.random() * 1.5 + 0.5,
                opacity: Math.random() * 0.5 + 0.5,
                twinkleSpeed: Math.random() * 0.02 + 0.01
            });
        }
        
        // 애니메이션
        const animate = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            
            for (const star of stars) {
                star.opacity += star.twinkleSpeed;
                if (star.opacity > 1 || star.opacity < 0.3) {
                    star.twinkleSpeed *= -1;
                }
                
                ctx.beginPath();
                ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(255, 255, 255, ${star.opacity})`;
                ctx.fill();
            }
            
            requestAnimationFrame(animate);
        };
        
        animate();
        
        // 리사이즈 대응
        window.addEventListener('resize', () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        });
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        // 인증 상태 변경
        eventBus.on(EVENTS.AUTH_STATE_CHANGED, ({ user }) => {
            this.updateAuthUI(user);
        });
        
        // 알림 이벤트
        eventBus.on(EVENTS.UI_NOTIFICATION, (data) => {
            this.showNotification(data);
        });
        
        // 결제 성공
        eventBus.on(EVENTS.PAYMENT_SUCCESS, async (data) => {
            const user = firebaseService.getCurrentUser();
            if (user) {
                await auctionSystem.instantConquest(
                    data.territoryId,
                    user.uid,
                    user.displayName || user.email
                );
            }
        });
    }
    
    /**
     * 키보드 단축키 설정
     */
    setupKeyboardShortcuts() {
        let pKeyCount = 0;
        let pKeyTimer = null;
        
        document.addEventListener('keydown', (e) => {
            // ESC: 패널 닫기
            if (e.key === 'Escape') {
                eventBus.emit(EVENTS.UI_PANEL_CLOSE, { type: 'territory' });
            }
            
            // H: 도움말
            if (e.key === 'h' || e.key === 'H') {
                eventBus.emit(EVENTS.UI_MODAL_OPEN, { type: 'help' });
            }
            
            // P 5회 연타: 관리자 모드
            if (e.key === 'p' || e.key === 'P') {
                pKeyCount++;
                clearTimeout(pKeyTimer);
                pKeyTimer = setTimeout(() => { pKeyCount = 0; }, 1000);
                
                if (pKeyCount >= 5) {
                    pKeyCount = 0;
                    eventBus.emit(EVENTS.UI_MODAL_OPEN, { type: 'admin' });
                }
            }
            
            // 1,2,3: 줌 레벨
            if (e.key === '1') mapController.flyTo([0, 20], 2);
            if (e.key === '2') mapController.flyTo([0, 20], 4);
            if (e.key === '3') mapController.flyTo([0, 20], 6);
        });
    }
    
    /**
     * 초기 데이터 로드
     */
    async loadInitialData() {
        // 미국을 기본으로 로드
        await this.loadCountry('usa');
    }
    
    /**
     * 국가 로드
     */
    async loadCountry(countryCode) {
        try {
            log.info(`Loading country: ${countryCode}`);
            
            // 로딩 표시
            this.showNotification({
                type: 'info',
                message: `Loading ${countryCode}...`
            });
            
            // GeoJSON 데이터 로드
            const geoJson = await mapController.loadGeoJsonData(countryCode);
            
            if (!geoJson || !geoJson.features || geoJson.features.length === 0) {
                this.showNotification({
                    type: 'warning',
                    message: `No region data available for this country yet.`
                });
                // 카메라는 이동
                mapController.flyToCountry(countryCode);
                return;
            }
            
            // 레이어 추가
            mapController.addTerritoryLayer(`territories-${countryCode}`, geoJson);
            
            // 국가로 이동
            mapController.flyToCountry(countryCode);
            
            this.currentCountry = countryCode;
            
            // 성공 알림
            this.showNotification({
                type: 'success',
                message: `Loaded ${geoJson.features.length} regions`
            });
            
        } catch (error) {
            log.error(`Failed to load country: ${countryCode}`, error);
            this.showNotification({
                type: 'error',
                message: 'Failed to load map data.'
            });
        }
    }
    
    /**
     * 인증 UI 업데이트
     */
    updateAuthUI(user) {
        const loginBtn = document.getElementById('side-user-login-btn');
        const logoutBtn = document.getElementById('side-user-logout-btn');
        const userEmail = document.getElementById('side-user-email');
        
        if (user) {
            if (loginBtn) loginBtn.classList.add('hidden');
            if (logoutBtn) logoutBtn.classList.remove('hidden');
            if (userEmail) {
                userEmail.textContent = user.email;
                userEmail.classList.remove('hidden');
            }
        } else {
            if (loginBtn) loginBtn.classList.remove('hidden');
            if (logoutBtn) logoutBtn.classList.add('hidden');
            if (userEmail) userEmail.classList.add('hidden');
        }
    }
    
    /**
     * 로딩 표시
     */
    showLoading() {
        const loading = document.getElementById('loading');
        if (loading) {
            loading.classList.remove('hidden');
        }
    }
    
    /**
     * 로딩 숨김
     */
    hideLoading() {
        const loading = document.getElementById('loading');
        if (loading) {
            loading.classList.add('hidden');
        }
    }
    
    /**
     * 에러 표시
     */
    showError(message) {
        const loading = document.getElementById('loading');
        if (loading) {
            loading.innerHTML = `
                <div class="error-icon">❌</div>
                <p>${message}</p>
                <button onclick="location.reload()">새로고침</button>
            `;
        }
    }
    
    /**
     * 알림 표시
     */
    showNotification({ type, message, duration = 3000 }) {
        const container = document.getElementById('notification-container') || this.createNotificationContainer();
        
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.innerHTML = `
            <div class="notification-content">
                <span class="notification-icon">${this.getNotificationIcon(type)}</span>
                <span class="notification-message">${message}</span>
                <button class="notification-close">&times;</button>
            </div>
        `;
        
        container.appendChild(notification);
        
        // 닫기 버튼
        notification.querySelector('.notification-close').addEventListener('click', () => {
            notification.remove();
        });
        
        // 자동 제거
        setTimeout(() => {
            notification.remove();
        }, duration);
    }
    
    createNotificationContainer() {
        const container = document.createElement('div');
        container.id = 'notification-container';
        document.body.appendChild(container);
        return container;
    }
    
    getNotificationIcon(type) {
        const icons = {
            success: '✅',
            error: '❌',
            warning: '⚠️',
            info: 'ℹ️'
        };
        return icons[type] || 'ℹ️';
    }
}

// 앱 인스턴스 생성 및 초기화
const app = new BillionaireApp();

// DOM 로드 후 초기화
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => app.init());
} else {
    app.init();
}

// 전역 접근용
window.BillionaireApp = app;
export default app;

