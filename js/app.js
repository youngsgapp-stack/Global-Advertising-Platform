/**
 * Billionaire Homepage v2 - Main Application
 * App Entry Point & Initialization
 */

import { CONFIG, log } from './config.js';
import { eventBus, EVENTS } from './core/EventBus.js';
import { mapController } from './core/MapController.js';
import { territoryManager } from './core/TerritoryManager.js';
import { firebaseService } from './services/FirebaseService.js';
import { walletService, WALLET_EVENTS } from './services/WalletService.js';
import { paymentService } from './services/PaymentService.js';
import { auctionSystem } from './features/AuctionSystem.js';
import { rankingSystem } from './features/RankingSystem.js';
import { buffSystem } from './features/BuffSystem.js';
import { collaborationHub } from './features/CollaborationHub.js';
import { historyLogger } from './features/HistoryLogger.js';
import { territoryPanel } from './ui/TerritoryPanel.js';
import { territoryListPanel } from './ui/TerritoryListPanel.js';
import { pixelEditor3 } from './ui/PixelEditor3.js';
import { rankingBoard } from './ui/RankingBoard.js';
import { timelineWidget } from './ui/TimelineWidget.js';
import { onboardingGuide } from './ui/OnboardingGuide.js';
import { recommendationSystem } from './features/RecommendationSystem.js';
import { recommendationPanel } from './ui/RecommendationPanel.js';
import { territoryDataService } from './services/TerritoryDataService.js';
import { analyticsService } from './services/AnalyticsService.js';
import { notificationService } from './services/NotificationService.js';
import { i18nService } from './services/I18nService.js';
import { abTestService } from './services/ABTestService.js';
import { feedbackService } from './services/FeedbackService.js';
import { localCacheService } from './services/LocalCacheService.js';
import { cacheService } from './services/CacheService.js';
import { monitoringService } from './services/MonitoringService.js';
import { serviceModeManager } from './services/ServiceModeManager.js';
import { rateLimiter } from './services/RateLimiter.js';
import { apiService } from './services/ApiService.js';
import { webSocketService } from './services/WebSocketService.js';
import { galleryView } from './ui/GalleryView.js';
import { contestPanel } from './ui/ContestPanel.js';
import { contestSystem } from './features/ContestSystem.js';
import { seasonSystem } from './features/SeasonSystem.js';
import './utils/ResetData.js'; // 데이터 초기화 유틸리티 (전역 함수로 등록)

class BillionaireApp {
    constructor() {
        this.initialized = false;
        this.currentCountry = null;
    }
    
    /**
     * App Initialization
     */
    async init() {
        try {
            log.info(`${CONFIG.APP_NAME} v${CONFIG.VERSION} initializing...`);
            
            // 1. Show loading
            this.showLoading();
            
            // 2. Initialize Firebase & Data Services
            await firebaseService.initialize();
            
            // 2.1. Initialize API Service (새 백엔드)
            await apiService.initialize();
            
            // Firebase 초기화 후 현재 사용자 상태 확인 (리다이렉트 후 복원)
            setTimeout(async () => {
                const currentUser = firebaseService.getCurrentUser();
                if (currentUser) {
                    console.log('[BillionaireApp] 🔍 Found existing user after init:', currentUser.email);
                    this.updateAuthUI(currentUser);
                    
                    // 사용자가 있으면 WebSocket 연결
                    await webSocketService.connect();
                }
            }, 1000);
            
            await territoryDataService.initialize();
            
            // 2.4. Initialize Local Cache Service (IndexedDB)
            await localCacheService.initialize();
            
            // 2.4.1. Initialize Cache Service
            await cacheService.initialize();
            
            // 2.4.2. Initialize Monitoring Service
            await monitoringService.initialize();
            
            // 2.4.3. Initialize Service Mode Manager
            await serviceModeManager.initialize();
            
            // 2.4.4. Initialize Rate Limiter
            await rateLimiter.initialize();
            
            // 2.4.5. Initialize Performance Optimizer (CPU 최적화)
            const { performanceOptimizer } = await import('./services/PerformanceOptimizer.js');
            await performanceOptimizer.initialize();
            
            // 2.4.6. Make monitoringService globally available for FirebaseService
            window.monitoringService = monitoringService;
            
            // 2.4.7. Make serviceModeManager globally available
            window.serviceModeManager = serviceModeManager;
            
            // 2.5. Initialize Services
            await analyticsService.initialize();
            await notificationService.initialize();
            i18nService.initialize();
            
            // 2.6. Initialize A/B Tests
            abTestService.initializePaymentButtonTest();
            abTestService.initializeOnboardingTest();
            
            // 2.5. Initialize Wallet & Payment Services
            await walletService.initialize();
            await paymentService.initialize();
            
            // ⚠️ Step 6-5: 순차 로딩 전략 - 맵은 먼저, 나머지는 순차적으로
            this.updateLoadingProgress('Initializing map...', 30);
            
            // 3. Initialize Map (우선 로드)
            await mapController.initialize('map');
            this.updateLoadingProgress('Map loaded', 40);
            
            // 4. Initialize Territory Manager
            await territoryManager.initialize();
            this.updateLoadingProgress('Territory system ready', 50);
            
            // 5. Initialize Core Features (우선 로드)
            await auctionSystem.initialize();
            this.updateLoadingProgress('Auction system ready', 60);
            
            // 6. Initialize UI (기본 UI 먼저)
            territoryPanel.initialize();
            territoryListPanel.initialize();
            this.initializeUI();
            this.updateLoadingProgress('UI components ready', 70);
            
            // 7. Setup Event Listeners
            this.setupEventListeners();
            this.setupGlobalErrorHandlers();
            
            // 8. Load Initial Data (맵과 기본 기능 로드 완료 후)
            this.updateLoadingProgress('Loading initial data...', 80);
            await this.loadInitialData();
            this.updateLoadingProgress('Initial data loaded', 90);
            
            // 9. Initialize Secondary Features (백그라운드에서 순차 로드)
            // ⚠️ Step 6-5: 나머지 기능들은 병렬로 로드하되, UI는 즉시 표시
            Promise.all([
                rankingSystem.initialize(),
                buffSystem.initialize(),
                collaborationHub.initialize(),
                historyLogger.initialize(),
                recommendationSystem.initialize(),
                contestSystem.initialize(),
                seasonSystem.initialize(),
                pixelEditor3.initialize(),
                rankingBoard.initialize(),
                timelineWidget.initialize(),
                recommendationPanel.initialize(),
                onboardingGuide.initialize(),
                galleryView.initialize(),
                contestPanel.initialize(),
                this.initializeFeedbackButton()
            ]).then(() => {
                this.updateLoadingProgress('All features loaded', 95);
            }).catch(err => {
                log.warn('[BillionaireApp] Some features failed to load:', err);
            });
            
            // 10. Hide loading (맵과 기본 기능 로드 완료 후)
            this.updateLoadingProgress('Ready!', 100);
            setTimeout(() => {
                this.hideLoading();
            }, 500);
            
            this.initialized = true;
            log.info('App initialized successfully!');
            eventBus.emit(EVENTS.APP_READY, {});
            
        } catch (error) {
            log.error('App initialization failed:', error);
            this.showError('Failed to start the app. Please refresh the page.');
            eventBus.emit(EVENTS.APP_ERROR, { error });
        }
    }
    
    /**
     * UI Initialization
     */
    initializeUI() {
        // Initialize view mode toggle
        this.initViewModeToggle();
        
        // Initialize country selector
        this.initCountrySelector();
        
        // Initialize hamburger menu
        this.initHamburgerMenu();
        
        // Initialize stars background
        this.initStarsBackground();
        
        // Setup keyboard shortcuts
        this.setupKeyboardShortcuts();
        
        // Check admin user mode
        this.checkAdminUserMode();
        
        // Initialize Accessibility
        this.initializeAccessibility();
    }
    
    /**
     * 접근성 초기화
     */
    initializeAccessibility() {
        // 키보드 네비게이션 지원
        this.setupKeyboardNavigation();
        
        // ARIA 레이블 추가
        this.setupAriaLabels();
        
        // 스크린 리더 지원
        this.setupScreenReaderSupport();
        
        log.info('[BillionaireApp] Accessibility initialized');
    }
    
    /**
     * 키보드 네비게이션 설정
     */
    setupKeyboardNavigation() {
        // 이미 setupKeyboardShortcuts에서 처리됨
        // 추가 키보드 접근성 기능이 필요하면 여기에 구현
    }
    
    /**
     * ARIA 레이블 설정
     */
    setupAriaLabels() {
        // 주요 버튼에 ARIA 레이블 추가
        const viewModeToggle = document.getElementById('view-mode-toggle');
        if (viewModeToggle && !viewModeToggle.getAttribute('aria-label')) {
            viewModeToggle.setAttribute('aria-label', 'Toggle between world view and country view');
        }
        
        const hamburgerMenu = document.getElementById('hamburger-menu-btn');
        if (hamburgerMenu && !hamburgerMenu.getAttribute('aria-label')) {
            hamburgerMenu.setAttribute('aria-label', 'Open menu');
        }
        
        const countrySelector = document.getElementById('country-selector');
        if (countrySelector && !countrySelector.getAttribute('aria-label')) {
            countrySelector.setAttribute('aria-label', 'Select country');
        }
    }
    
    /**
     * 스크린 리더 지원 설정
     */
    setupScreenReaderSupport() {
        // 라이브 영역 생성 (동적 콘텐츠 알림용)
        let liveRegion = document.getElementById('sr-live-region');
        if (!liveRegion) {
            liveRegion = document.createElement('div');
            liveRegion.id = 'sr-live-region';
            liveRegion.setAttribute('role', 'status');
            liveRegion.setAttribute('aria-live', 'polite');
            liveRegion.setAttribute('aria-atomic', 'true');
            liveRegion.className = 'sr-only';
            liveRegion.style.cssText = 'position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden;';
            document.body.appendChild(liveRegion);
        }
        
        // 이벤트 리스너: 스크린 리더 알림
        eventBus.on(EVENTS.TERRITORY_SELECT, ({ territoryId }) => {
            if (liveRegion) {
                liveRegion.textContent = `Territory ${territoryId} selected`;
            }
        });
    }
    
    /**
     * 관리자 사용자 모드 체크 및 배너 표시
     */
    async checkAdminUserMode() {
        const isAdminUserMode = sessionStorage.getItem('adminUserMode') === 'true';
        const hasAdminAuth = sessionStorage.getItem('adminAuth');
        
        if (isAdminUserMode && hasAdminAuth) {
            // 관리자 사용자 모드 배너 표시
            const banner = document.getElementById('admin-user-mode-banner');
            if (banner) {
                banner.classList.remove('hidden');
                
                // 관리자 페이지로 돌아가기 버튼
                const backBtn = document.getElementById('back-to-admin');
                if (backBtn) {
                    backBtn.addEventListener('click', () => {
                        sessionStorage.removeItem('adminUserMode');
                        window.location.href = 'admin.html';
                    });
                }
            }
            
            // 관리자 모드일 때 가상 사용자 객체 생성 및 로그인 처리
            try {
                const adminAuthData = JSON.parse(hasAdminAuth);
                const adminId = adminAuthData.id || 'admin';
                const adminEmail = adminAuthData.email || `${adminId}@admin.local`;
                
                console.log(`[BillionaireApp] Admin user mode: adminId=${adminId}, email=${adminEmail}`);
                
                // 가상 사용자 객체 생성 (Firebase Auth 사용자와 유사한 구조)
                // 실제 관리자 이메일을 사용하여 고유한 사용자로 인식
                const virtualUser = {
                    uid: `admin_${adminId}_${adminEmail.replace(/[@.]/g, '_')}`,
                    email: adminEmail,
                    displayName: `Admin (${adminId})`,
                    emailVerified: true,
                    isAnonymous: false,
                    metadata: {
                        creationTime: new Date().toISOString(),
                        lastSignInTime: new Date().toISOString()
                    },
                    providerData: [{
                        providerId: 'admin',
                        uid: adminId,
                        displayName: `Admin (${adminId})`,
                        email: adminEmail
                    }],
                    // 관리자 모드 플래그
                    isAdmin: true,
                    adminMode: true,
                    adminId: adminId
                };
                
                // FirebaseService에 가상 사용자 설정
                firebaseService.setVirtualUser(virtualUser);
                
                // AUTH_STATE_CHANGED 이벤트 발행 (다른 서비스들이 사용자로 인식하도록)
                eventBus.emit(EVENTS.AUTH_STATE_CHANGED, { user: virtualUser });
                eventBus.emit(EVENTS.AUTH_LOGIN, { user: virtualUser });
                
                log.info('관리자 사용자 모드 활성화 - 가상 사용자 생성:', virtualUser.email);
                
            } catch (error) {
                log.error('관리자 모드 가상 사용자 생성 실패:', error);
            }
        }
    }
    
    /**
     * View Mode Toggle Initialization
     */
    initViewModeToggle() {
        const toggleBtn = document.getElementById('view-mode-toggle');
        if (!toggleBtn) return;
        
        toggleBtn.addEventListener('click', async () => {
            const currentMode = mapController.getViewMode();
            
            if (currentMode === 'country') {
                // Switch to World View
                toggleBtn.textContent = '📍 Country';
                toggleBtn.classList.add('active');
                await mapController.loadWorldView();
            } else {
                // Switch to Country View
                toggleBtn.textContent = '🌍 World';
                toggleBtn.classList.remove('active');
                mapController.setViewMode('country');
                // 다른 나라 행정구역 표시 유지를 위해 clearAllTerritoryLayers 제거
                // mapController.clearAllTerritoryLayers();
                
                // Reload last country or default to USA
                const country = this.currentCountry || 'usa';
                await this.loadCountry(country);
            }
        });
        
        // Listen for reload-country event
        eventBus.on('reload-country', async ({ country }) => {
            await this.loadCountry(country);
        });
        
        // Listen for load-country event (from recommendations)
        eventBus.on('load-country', async ({ country }) => {
            // Switch to Country View if in World View
            const toggleBtn = document.getElementById('view-mode-toggle');
            if (mapController.getViewMode() === 'world') {
                toggleBtn.textContent = '🌍 World';
                toggleBtn.classList.remove('active');
                mapController.setViewMode('country');
            }
            await this.loadCountry(country);
        });
    }
    
    /**
     * Country Selector Initialization - Grouped by Continent
     */
    initCountrySelector() {
        const selector = document.getElementById('country-selector');
        if (!selector) return;
        
        // Group definitions
        const groups = {
            'asia': { label: '🌏 Asia', countries: [] },
            'middle-east': { label: '🏜️ Middle East', countries: [] },
            'europe': { label: '🇪🇺 Europe', countries: [] },
            'north-america': { label: '🌎 North America', countries: [] },
            'south-america': { label: '🌎 South America', countries: [] },
            'africa': { label: '🌍 Africa', countries: [] },
            'oceania': { label: '🌏 Oceania', countries: [] }
        };
        
        // Group countries by continent
        for (const [code, country] of Object.entries(CONFIG.COUNTRIES)) {
            const group = country.group || country.continent || 'asia';
            if (groups[group]) {
                groups[group].countries.push({ code, ...country });
            }
        }
        
        // Create optgroups
        for (const [groupKey, group] of Object.entries(groups)) {
            if (group.countries.length === 0) continue;
            
            const optgroup = document.createElement('optgroup');
            optgroup.label = group.label;
            
            // Sort by name
            group.countries.sort((a, b) => a.name.localeCompare(b.name));
            
            for (const country of group.countries) {
                const option = document.createElement('option');
                option.value = country.code;
                option.textContent = `${country.flag} ${country.name}`;
                optgroup.appendChild(option);
            }
            
            selector.appendChild(optgroup);
        }
        
        // Change event
        selector.addEventListener('change', (e) => {
            const countryCode = e.target.value;
            if (countryCode) {
                this.loadCountry(countryCode);
            }
        });
    }
    
    /**
     * Hamburger Menu Initialization
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
        
        // Login/Logout buttons
        const loginBtn = document.getElementById('side-user-login-btn');
        const logoutBtn = document.getElementById('side-user-logout-btn');
        
        if (loginBtn) {
            loginBtn.addEventListener('click', async () => {
                try {
                    await firebaseService.signInWithGoogle();
                } catch (error) {
                    // 오류는 AUTH_ERROR 이벤트로 처리됨
                    // 리다이렉트의 경우 null을 반환하므로 오류가 아님
                }
            });
        }
        
        if (logoutBtn) {
            logoutBtn.addEventListener('click', () => {
                firebaseService.signOut();
            });
        }
        
        // Wallet button
        const walletBtn = document.getElementById('open-wallet-modal');
        if (walletBtn) {
            walletBtn.addEventListener('click', async () => {
                const user = firebaseService.getCurrentUser();
                if (user) {
                    paymentService.openChargeModal();
                } else {
                    this.showNotification({
                        type: 'warning',
                        message: 'Please sign in to access your wallet'
                    });
                    try {
                        await firebaseService.signInWithGoogle();
                    } catch (error) {
                        // 오류는 AUTH_ERROR 이벤트로 처리됨
                    }
                }
            });
        }
    }
    
    /**
     * Stars Background Initialization
     */
    initStarsBackground() {
        const canvas = document.getElementById('stars-canvas');
        if (!canvas) return;
        
        const ctx = canvas.getContext('2d');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        
        // Create stars
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
        
        // Animation
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
        
        // Handle resize
        window.addEventListener('resize', () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        });
    }
    
    /**
     * Setup Event Listeners
     */
    setupEventListeners() {
        // Auth state change
        eventBus.on(EVENTS.AUTH_STATE_CHANGED, async ({ user }) => {
            console.log('[BillionaireApp] 🔐 AUTH_STATE_CHANGED event received, user:', user ? user.email : 'null');
            
            // 사용자가 로그인하면 WebSocket 연결
            if (user) {
                try {
                    await webSocketService.connect();
                    
                    // WebSocket 이벤트 핸들러 설정
                    this.setupWebSocketHandlers();
                } catch (error) {
                    log.error('[BillionaireApp] Failed to connect WebSocket:', error);
                }
            } else {
                // 로그아웃 시 WebSocket 연결 해제
                webSocketService.disconnect();
            }
            this.updateAuthUI(user);
            
            // 사용자가 로그인한 경우 지갑 잔액 새로고침
            if (user) {
                log.info(`[BillionaireApp] 💰 User logged in, refreshing wallet balance for ${user.uid}`);
                // 약간의 지연 후 지갑 새로고침 (WalletService가 이벤트를 처리한 후)
                setTimeout(() => {
                    walletService.refreshBalance().catch(err => {
                        log.warn('[BillionaireApp] Failed to refresh balance after login:', err);
                    });
                }, 500);
            }
        });
        
        // Notification event
        eventBus.on(EVENTS.UI_NOTIFICATION, (data) => {
            this.showNotification(data);
        });
        
        // Wallet balance update
        eventBus.on(WALLET_EVENTS.BALANCE_UPDATED, ({ balance }) => {
            log.info(`[BillionaireApp] 💰 BALANCE_UPDATED event received: ${balance} pt`);
            // balance가 undefined이거나 null인 경우 WalletService에서 다시 가져오기
            if (balance === undefined || balance === null) {
                const currentBalance = walletService.getBalance();
                log.info(`[BillionaireApp] 💰 Balance was undefined, using WalletService balance: ${currentBalance} pt`);
                this.updateWalletUI(currentBalance);
            } else {
                this.updateWalletUI(balance);
            }
        });
        
        // 새로고침 시 지갑 잔액 초기 업데이트 (페이지 로드 후)
        // 여러 시점에서 확인하여 누락 방지
        const updateBalanceOnLoad = () => {
            const user = firebaseService.getCurrentUser();
            if (user) {
                const balance = walletService.getBalance();
                if (balance !== null && balance !== undefined) {
                    log.info(`[BillionaireApp] 💰 Initial wallet balance update on page load: ${balance} pt`);
                    this.updateWalletUI(balance);
                    return true; // 업데이트 성공
                }
            }
            return false; // 아직 로딩 중
        };
        
        // DOMContentLoaded 시도
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                setTimeout(updateBalanceOnLoad, 500);
            });
        } else {
            // 이미 로드된 경우 즉시 시도
            setTimeout(updateBalanceOnLoad, 500);
        }
        
        // window.load 이벤트에서도 시도
        window.addEventListener('load', () => {
            setTimeout(() => {
                if (!updateBalanceOnLoad()) {
                    // 실패 시 1초 후 재시도
                    setTimeout(updateBalanceOnLoad, 1000);
                }
            }, 1000);
        });
        
        // Payment success - handle territory conquest
        eventBus.on(EVENTS.PAYMENT_SUCCESS, async (data) => {
            log.info(`[BillionaireApp] 💰 PAYMENT_SUCCESS event received:`, data);
            const user = firebaseService.getCurrentUser();
            if (user && data.territoryId) {
                log.info(`[BillionaireApp] 🎯 Calling instantConquest for territory: ${data.territoryId}, user: ${user.uid}, protectionDays: ${data.protectionDays || null}`);
                try {
                await auctionSystem.instantConquest(
                    data.territoryId,
                    user.uid,
                    user.displayName || user.email,
                    data.amount,
                    data.protectionDays || null
                );
                    log.info(`[BillionaireApp] ✅ instantConquest completed for territory: ${data.territoryId}`);
                } catch (error) {
                    log.error(`[BillionaireApp] ❌ instantConquest failed for territory: ${data.territoryId}:`, error);
                }
            } else {
                log.warn(`[BillionaireApp] ⚠️ PAYMENT_SUCCESS event missing user or territoryId:`, { user: !!user, territoryId: data.territoryId });
            }
        });
        
        // Insufficient balance - open charge modal
        eventBus.on(WALLET_EVENTS.INSUFFICIENT_BALANCE, ({ required, current }) => {
            this.showNotification({
                type: 'warning',
                message: `Insufficient balance. Need ${required} pt, have ${current} pt`
            });
            paymentService.openChargeModal(required);
        });
        
        // Help section buttons
        document.getElementById('side-help-btn')?.addEventListener('click', () => {
            this.showHowToPlayModal();
        });
        
        document.getElementById('side-about-btn')?.addEventListener('click', () => {
            this.showAboutModal();
        });
        
        // Ranking section buttons
        document.getElementById('side-ranking-btn')?.addEventListener('click', () => {
            rankingBoard.open();
            // 사이드 메뉴 닫기
            const sideMenu = document.getElementById('side-menu');
            if (sideMenu) {
                sideMenu.classList.add('hidden');
            }
        });
        
        document.getElementById('side-my-territories-btn')?.addEventListener('click', () => {
            territoryListPanel.open();
            // 사이드 메뉴 닫기
            const sideMenu = document.getElementById('side-menu');
            if (sideMenu) {
                sideMenu.classList.add('hidden');
            }
        });
        
        // Gallery button
        document.getElementById('side-gallery-btn')?.addEventListener('click', () => {
            galleryView.open();
            // 사이드 메뉴 닫기
            const sideMenu = document.getElementById('side-menu');
            if (sideMenu) {
                sideMenu.classList.add('hidden');
            }
        });
        
        // Contest button
        document.getElementById('side-contest-btn')?.addEventListener('click', () => {
            contestPanel.open();
            // 사이드 메뉴 닫기
            const sideMenu = document.getElementById('side-menu');
            if (sideMenu) {
                sideMenu.classList.add('hidden');
            }
        });
        
        // UI_MODAL_OPEN 이벤트 처리 (로그인 모달 등)
        eventBus.on(EVENTS.UI_MODAL_OPEN, (data) => {
            if (data.type === 'login') {
                console.log('[BillionaireApp] 🔐 Login modal opened, calling signInWithGoogle...');
                firebaseService.signInWithGoogle().then((user) => {
                    if (user) {
                        console.log('[BillionaireApp] ✅ Login successful:', user.email);
                    } else {
                        console.log('[BillionaireApp] ℹ️ Login initiated (redirect), user will be redirected');
                    }
                }).catch((error) => {
                    console.error('[BillionaireApp] ❌ Login error:', error.code, error.message);
                    // 리다이렉트의 경우 null을 반환하므로 오류가 아님
                    if (error && error.code !== 'auth/cancelled-popup-request') {
                        // 오류는 AUTH_ERROR 이벤트로 처리됨
                    }
                });
            }
        });
        
        // AUTH_ERROR 이벤트 처리
        eventBus.on(EVENTS.AUTH_ERROR, ({ error }) => {
            let message = '로그인에 실패했습니다.';
            let actionButton = null;
            
            if (error.code === 'auth/unauthorized-domain') {
                const domain = error.domain || window.location.hostname;
                message = `현재 도메인(${domain})이 Firebase에 등록되지 않았습니다.`;
                
                // Firebase 콘솔 링크 버튼 추가
                if (error.consoleLink) {
                    actionButton = {
                        text: 'Firebase 콘솔 열기',
                        action: () => {
                            window.open(error.consoleLink, '_blank');
                        }
                    };
                }
                
                // 상세 안내 메시지 표시
                setTimeout(() => {
                    const detailMessage = error.message || `Firebase 콘솔에서 "${domain}" 도메인을 추가해주세요.`;
                    if (confirm(`${message}\n\n${detailMessage}\n\nFirebase 콘솔을 열까요?`)) {
                        if (error.consoleLink) {
                            window.open(error.consoleLink, '_blank');
                        }
                    }
                }, 100);
            } else if (error.code === 'auth/popup-closed-by-user') {
                message = '로그인 창이 닫혔습니다. 다시 시도해주세요.';
            } else if (error.code === 'auth/popup-blocked') {
                message = '팝업이 차단되었습니다. 리다이렉트 방식으로 로그인을 시도합니다...';
                // 리다이렉트는 이미 signInWithGoogle에서 처리됨
            } else if (error.message?.includes('Cross-Origin-Opener-Policy')) {
                message = '브라우저 보안 정책으로 인해 팝업이 차단되었습니다. 리다이렉트 방식으로 로그인을 시도합니다...';
            } else if (error.message) {
                message = error.message;
            }
            
            this.showNotification({
                type: 'error',
                message: message,
                duration: 8000
            });
        });
    }
    
    /**
     * 전역 에러 핸들러 설정
     */
    setupGlobalErrorHandlers() {
        // 전역 JavaScript 에러 핸들링
        window.addEventListener('error', (event) => {
            log.error('[GlobalError] JavaScript Error:', {
                message: event.message,
                filename: event.filename,
                lineno: event.lineno,
                colno: event.colno,
                error: event.error
            });
            
            // 사용자 친화적 메시지 표시
            if (!event.error || !event.error.isUserFriendly) {
                this.showNotification({
                    type: 'error',
                    message: '예기치 않은 오류가 발생했습니다. 페이지를 새로고침해주세요.',
                    duration: 5000
                });
            }
            
            // 프로덕션에서는 에러 리포팅 서비스에 전송
            // 예: Sentry, LogRocket 등
            // if (CONFIG.ENVIRONMENT === 'production') {
            //     errorReportingService.captureException(event.error);
            // }
        });
        
        // Promise rejection 핸들링
        window.addEventListener('unhandledrejection', (event) => {
            log.error('[GlobalError] Unhandled Promise Rejection:', event.reason);
            
            // 네트워크 오류인 경우
            if (event.reason && (
                event.reason.message?.includes('network') ||
                event.reason.message?.includes('fetch') ||
                event.reason.code === 'network-error'
            )) {
                this.showNotification({
                    type: 'error',
                    message: '네트워크 연결을 확인해주세요.',
                    duration: 5000
                });
            } else {
                this.showNotification({
                    type: 'error',
                    message: '작업을 완료할 수 없습니다. 다시 시도해주세요.',
                    duration: 5000
                });
            }
            
            event.preventDefault(); // 콘솔 에러 출력 방지 (선택적)
        });
        
        // Firebase 에러 핸들링
        eventBus.on(EVENTS.APP_ERROR, ({ error, type }) => {
            log.error(`[AppError] ${type || 'Unknown'} Error:`, error);
            
            let message = '오류가 발생했습니다.';
            
            if (type === 'firebase') {
                message = '데이터베이스 연결 오류입니다. 인터넷 연결을 확인해주세요.';
            } else if (type === 'map') {
                message = '지도를 불러올 수 없습니다. 페이지를 새로고침해주세요.';
            } else if (type === 'payment') {
                message = '결제 처리 중 오류가 발생했습니다. 다시 시도해주세요.';
            }
            
            this.showNotification({
                type: 'error',
                message: message,
                duration: 7000
            });
        });
        
        // 네트워크 상태 모니터링
        if ('navigator' in window && 'onLine' in navigator) {
            window.addEventListener('online', () => {
                this.showNotification({
                    type: 'success',
                    message: '인터넷 연결이 복구되었습니다.',
                    duration: 3000
                });
            });
            
            window.addEventListener('offline', () => {
                this.showNotification({
                    type: 'warning',
                    message: '인터넷 연결이 끊겼습니다.',
                    duration: 5000
                });
            });
        }
    }
    
    /**
     * Show How to Play Modal
     */
    showHowToPlayModal() {
        const existingModal = document.querySelector('.help-modal');
        if (existingModal) existingModal.remove();
        
        const modal = document.createElement('div');
        modal.className = 'modal help-modal';
        modal.innerHTML = `
            <div class="modal-content help-modal-content">
                <div class="modal-header">
                    <h2>📖 How to Play</h2>
                    <button class="close-btn" id="close-help-modal">&times;</button>
                </div>
                <div class="modal-body help-body">
                    <div class="help-section">
                        <h3>🌍 1. Explore the Globe</h3>
                        <p>Rotate and zoom the 3D globe to discover territories around the world. Click on any country to see its administrative regions.</p>
                    </div>
                    
                    <div class="help-section">
                        <h3>💰 2. Charge Points</h3>
                        <p>Click the <strong>💰 Wallet</strong> button to charge points via PayPal. Points are used to purchase territories and place auction bids.</p>
                        <ul>
                            <li>$10 → 1,000 pt</li>
                            <li>$25 → 2,750 pt (+10% bonus)</li>
                            <li>$50 → 6,000 pt (+20% bonus)</li>
                        </ul>
                    </div>
                    
                    <div class="help-section">
                        <h3>🏴 3. Own Territories</h3>
                        <p>Click on an available territory and hit <strong>"Own This Territory"</strong> to instantly purchase it. Each territory has a unique price based on population and area.</p>
                    </div>
                    
                    <div class="help-section">
                        <h3>🔥 4. Join Auctions</h3>
                        <p>Compete with other players by placing bids on territories. The highest bidder wins when the auction ends!</p>
                        <ul>
                            <li>🏠 Adjacent Territory Bonus: +5~15%</li>
                            <li>🌍 Country Domination Bonus: +3~10%</li>
                            <li>📅 Season Bonus: +5~20%</li>
                        </ul>
                    </div>
                    
                    <div class="help-section">
                        <h3>🎨 5. Decorate Your Land</h3>
                        <p>Use the <strong>Pixel Editor</strong> to draw on your territories. Your artwork becomes part of the map for everyone to see!</p>
                    </div>
                    
                    <div class="help-section">
                        <h3>🏆 6. Climb Rankings</h3>
                        <p>Earn points by owning territories, creating pixel art, and dominating countries. Compete on the global leaderboard!</p>
                    </div>
                    
                    <div class="help-section">
                        <h3>⌨️ Keyboard Shortcuts</h3>
                        <ul>
                            <li><kbd>H</kbd> - Open Help</li>
                            <li><kbd>ESC</kbd> - Close panels</li>
                            <li><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> - Zoom levels</li>
                        </ul>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        document.getElementById('close-help-modal')?.addEventListener('click', () => {
            modal.remove();
        });
        
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });
    }
    
    /**
     * Show About Modal
     */
    showAboutModal() {
        const existingModal = document.querySelector('.about-modal');
        if (existingModal) existingModal.remove();
        
        const modal = document.createElement('div');
        modal.className = 'modal about-modal';
        modal.innerHTML = `
            <div class="modal-content about-modal-content">
                <div class="modal-header">
                        <h2>ℹ️ About Own a Piece of Earth</h2>
                    <button class="close-btn" id="close-about-modal">&times;</button>
                </div>
                <div class="modal-body about-body">
                    <div class="about-hero">
                        <h1>🌍 Own a Piece of Earth</h1>
                        <p class="tagline">"Own Piece"</p>
                        <p class="version">Version ${CONFIG.VERSION}</p>
                    </div>
                    
                    <div class="about-section">
                        <h3>🎮 What is Own a Piece of Earth?</h3>
                        <p>Own a Piece of Earth is an interactive global territory game where players can purchase, auction, and decorate real-world administrative regions. Build your empire, compete with others, and leave your mark on the world!</p>
                    </div>
                    
                    <div class="about-section">
                        <h3>✨ Features</h3>
                        <ul>
                            <li>🌐 200+ countries with real administrative regions</li>
                            <li>💰 Point-based economy with PayPal integration</li>
                            <li>🔥 Competitive auction system with strategic buffs</li>
                            <li>🎨 Pixel art editor for territory customization</li>
                            <li>🏆 Global rankings and achievements</li>
                            <li>🤝 Collaboration features for team artwork</li>
                        </ul>
                    </div>
                    
                    <div class="about-section">
                        <h3>📊 Statistics</h3>
                        <ul>
                            <li>🗺️ 200+ supported countries</li>
                            <li>🏛️ 10,000+ administrative regions</li>
                            <li>🎨 Unlimited pixel art possibilities</li>
                        </ul>
                    </div>
                    
                    <div class="about-section">
                        <h3>📧 Contact</h3>
                        <p>Questions or feedback? Reach out to us!</p>
                        <p>Email: support@billionairemap.com</p>
                    </div>
                    
                    <div class="about-footer">
                        <p>© 2025 Own a Piece of Earth. All rights reserved.</p>
                        <p>Made with ❤️ for global explorers</p>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        document.getElementById('close-about-modal')?.addEventListener('click', () => {
            modal.remove();
        });
        
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });
    }
    
    /**
     * WebSocket 이벤트 핸들러 설정
     */
    setupWebSocketHandlers() {
        // 입찰 업데이트 이벤트
        webSocketService.on('bidUpdate', async (data) => {
            log.info('[BillionaireApp] 📨 WebSocket bidUpdate received:', data);
            
            // EventBus로 발행하여 기존 시스템과 통합
            eventBus.emit(EVENTS.AUCTION_BID, {
                auctionId: data.auctionId,
                territoryId: data.territoryId,
                amount: data.amount,
                bidderId: data.bidderId,
                bidderNickname: data.bidderNickname,
                timestamp: data.timestamp
            });
            
            // 경매 업데이트 이벤트도 발행 (UI 새로고침용)
            eventBus.emit(EVENTS.AUCTION_UPDATE, {
                auction: {
                    id: data.auctionId,
                    territoryId: data.territoryId,
                    currentBid: data.amount,
                    currentBidderId: data.bidderId,
                    currentBidderNickname: data.bidderNickname
                }
            });
        });
        
        // 영토 업데이트 이벤트
        webSocketService.on('territoryUpdate', async (data) => {
            log.info('[BillionaireApp] 📨 WebSocket territoryUpdate received:', data);
            
            // EventBus로 발행하여 기존 시스템과 통합
            eventBus.emit(EVENTS.TERRITORY_UPDATE, {
                territory: data
            });
            
            // 영토 정복 이벤트 (필요한 경우)
            if (data.status === 'occupied' && data.previousStatus !== 'occupied') {
                eventBus.emit(EVENTS.TERRITORY_CONQUERED, {
                    territoryId: data.territoryId || data.id,
                    userId: data.rulerId,
                    userName: data.rulerNickname
                });
            }
        });
        
        // 연결 상태 이벤트
        eventBus.on(EVENTS.WEBSOCKET_CONNECTED, () => {
            log.info('[BillionaireApp] ✅ WebSocket connected, real-time updates enabled');
        });
        
        eventBus.on(EVENTS.WEBSOCKET_DISCONNECTED, () => {
            log.warn('[BillionaireApp] ⚠️ WebSocket disconnected, real-time updates disabled');
        });
    }
    
    /**
     * Update Wallet UI
     */
    updateWalletUI(balance) {
        log.info(`[BillionaireApp] 🔄 updateWalletUI called: balance=${balance}`);
        
        // balance가 null이거나 undefined인 경우 (로딩 중)
        if (balance === null || balance === undefined) {
            const user = firebaseService.getCurrentUser();
            if (user) {
                const walletBalance = walletService.getBalance();
                // WalletService에서 balance를 가져올 수 있으면 사용
                if (walletBalance !== null && walletBalance !== undefined) {
                    balance = walletBalance;
                    log.info(`[BillionaireApp] 💰 Using WalletService balance: ${balance} pt`);
                } else {
                    // 아직 로딩 중이면 로딩 표시
                    const walletDisplay = document.getElementById('wallet-balance');
                    if (walletDisplay) {
                        walletDisplay.textContent = 'Loading...';
                    }
                    const headerWallet = document.getElementById('header-wallet-balance');
                    if (headerWallet) {
                        headerWallet.textContent = 'Loading...';
                    }
                    return;
                }
            } else {
                // 로그인 안 되어 있으면 0 표시
                balance = 0;
            }
        }
        
        // balance가 0이고 사용자가 로그인되어 있으면 WalletService에서 다시 확인
        if (balance === 0) {
            const user = firebaseService.getCurrentUser();
            if (user) {
                const walletBalance = walletService.getBalance();
                // WalletService가 로딩 중이 아니고 값이 있으면 사용
                if (walletBalance !== null && walletBalance !== undefined && walletBalance > 0) {
                    log.info(`[BillionaireApp] 💰 Balance was 0 but WalletService has ${walletBalance} pt, using WalletService balance`);
                    balance = walletBalance;
                } else if (walletBalance === null || walletBalance === undefined) {
                    // 아직 로딩 중이면 잠시 대기
                    log.info(`[BillionaireApp] 💰 WalletService still loading, will update when ready`);
                    return;
                }
            }
        }
        
        const walletDisplay = document.getElementById('wallet-balance');
        if (walletDisplay) {
            walletDisplay.textContent = `${balance.toLocaleString()} pt`;
            log.info(`[BillionaireApp] ✅ Updated wallet-balance element: ${balance.toLocaleString()} pt`);
        }
        // wallet-balance 요소가 없어도 정상 동작 (header-wallet-balance만 사용하는 경우)
        
        const headerWallet = document.getElementById('header-wallet-balance');
        if (headerWallet) {
            headerWallet.textContent = `${balance.toLocaleString()} pt`;
            log.info(`[BillionaireApp] ✅ Updated header-wallet-balance element: ${balance.toLocaleString()} pt`);
        } else {
            log.warn('[BillionaireApp] ⚠️ header-wallet-balance element not found');
        }
        
        // ⚠️ 전문가 조언: header-wallet이 hidden 상태인지 확인
        const headerWalletContainer = document.getElementById('header-wallet');
        if (headerWalletContainer) {
            if (headerWalletContainer.classList.contains('hidden')) {
                log.warn('[BillionaireApp] ⚠️ header-wallet is hidden! Balance updated but not visible.');
            } else {
                log.info('[BillionaireApp] ✅ header-wallet is visible');
            }
        } else {
            log.warn('[BillionaireApp] ⚠️ header-wallet container not found');
        }
    }
    
    /**
     * Keyboard Shortcuts Setup
     */
    setupKeyboardShortcuts() {
        let pKeyCount = 0;
        let pKeyTimer = null;
        
        document.addEventListener('keydown', (e) => {
            // ESC: Close panel
            if (e.key === 'Escape') {
                eventBus.emit(EVENTS.UI_PANEL_CLOSE, { type: 'territory' });
                this.closeAdminModal();
            }
            
            // H: Help
            if (e.key === 'h' || e.key === 'H') {
                eventBus.emit(EVENTS.UI_MODAL_OPEN, { type: 'help' });
            }
            
            // P 5x tap: Admin mode
            if (e.key === 'p' || e.key === 'P') {
                pKeyCount++;
                clearTimeout(pKeyTimer);
                pKeyTimer = setTimeout(() => { pKeyCount = 0; }, 1000);
                
                if (pKeyCount >= 5) {
                    pKeyCount = 0;
                    this.openAdminModal();
                }
            }
            
            // 1,2,3: Zoom levels (disabled - 숫자 키 입력 방해 방지)
            // if (e.key === '1') mapController.flyTo([0, 20], 2);
            // if (e.key === '2') mapController.flyTo([0, 20], 4);
            // if (e.key === '3') mapController.flyTo([0, 20], 6);
        });
        
        // Admin modal event listeners
        this.setupAdminModal();
    }
    
    /**
     * Admin Modal Setup
     */
    setupAdminModal() {
        const modal = document.getElementById('admin-login-modal');
        const closeBtn = document.getElementById('close-admin-modal');
        const form = document.getElementById('admin-login-form-main');
        const overlay = modal?.querySelector('.modal-overlay');
        
        // Close button
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.closeAdminModal());
        }
        
        // Overlay click to close
        if (overlay) {
            overlay.addEventListener('click', () => this.closeAdminModal());
        }
        
        // Form submission
        if (form) {
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                this.handleAdminLogin();
            });
        }
    }
    
    /**
     * Open Admin Modal
     */
    openAdminModal() {
        const modal = document.getElementById('admin-login-modal');
        if (modal) {
            modal.classList.remove('hidden');
            document.getElementById('admin-email')?.focus();
            log.info('Admin modal opened');
        }
    }
    
    /**
     * Close Admin Modal
     */
    closeAdminModal() {
        const modal = document.getElementById('admin-login-modal');
        if (modal) {
            modal.classList.add('hidden');
            // Clear form
            const emailField = document.getElementById('admin-email');
            const pwdField = document.getElementById('admin-pwd');
            if (emailField) emailField.value = '';
            if (pwdField) pwdField.value = '';
            document.getElementById('admin-login-error')?.classList.add('hidden');
        }
    }
    
    /**
     * Handle Admin Login (Firebase Auth)
     */
    async handleAdminLogin() {
        const adminEmail = document.getElementById('admin-email')?.value?.trim();
        const adminPwd = document.getElementById('admin-pwd')?.value;
        const errorEl = document.getElementById('admin-login-error');
        const submitBtn = document.querySelector('#admin-login-form-main button[type="submit"]');
        
        // 관리자 이메일 목록
        const ADMIN_EMAILS = [
            'admin@billionairemap.com',
            'young91@naver.com',
            'q886654@naver.com',
            'etgbajy@gmail.com'
        ];
        
        if (!adminEmail || !adminPwd) {
            if (errorEl) {
                errorEl.textContent = '❌ 이메일과 비밀번호를 입력하세요';
                errorEl.classList.remove('hidden');
            }
            return;
        }
        
        // 로딩 상태
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = '🔄 로그인 중...';
        }
        
        try {
            // Firebase Auth로 로그인
            const userCredential = await firebaseService.signInWithEmail(adminEmail, adminPwd);
            const user = userCredential.user;
            
            // 관리자 이메일 확인
            if (!ADMIN_EMAILS.includes(user.email.toLowerCase())) {
                await firebaseService.signOut();
                throw new Error('관리자 권한이 없는 계정입니다');
            }
            
            // 로그인 성공
            this.showNotification({
                type: 'success',
                message: '✅ 관리자 로그인 성공!'
            });
            
            // 세션 스토리지에 관리자 상태 저장
            sessionStorage.setItem('adminAuth', JSON.stringify({
                id: user.email,
                uid: user.uid,
                timestamp: Date.now()
            }));
            
            this.closeAdminModal();
            
            // admin.html로 이동
            setTimeout(() => {
                window.location.href = 'admin.html';
            }, 500);
            
        } catch (error) {
            console.error('Admin login failed:', error);
            
            // 에러 메시지 표시
            let errorMsg = '❌ 로그인 실패';
            if (error.code === 'auth/user-not-found') {
                errorMsg = '❌ 등록되지 않은 이메일입니다';
            } else if (error.code === 'auth/wrong-password') {
                errorMsg = '❌ 비밀번호가 틀렸습니다';
            } else if (error.code === 'auth/invalid-email') {
                errorMsg = '❌ 유효하지 않은 이메일 형식입니다';
            } else if (error.code === 'auth/invalid-credential') {
                errorMsg = '❌ 이메일 또는 비밀번호가 틀렸습니다';
            } else if (error.message) {
                errorMsg = `❌ ${error.message}`;
            }
            
            if (errorEl) {
                errorEl.textContent = errorMsg;
                errorEl.classList.remove('hidden');
            }
        } finally {
            // 버튼 복구
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = '🔓 로그인';
            }
        }
    }
    
    /**
     * Load Initial Data
     */
    async loadInitialData() {
        // Start with World View as default
        const toggleBtn = document.getElementById('view-mode-toggle');
        if (toggleBtn) {
            toggleBtn.textContent = '📍 Country';
            toggleBtn.classList.add('active');
        }
        await mapController.loadWorldView();
    }
    
    /**
     * Load Country
     */
    async loadCountry(countryCode) {
        try {
            log.info(`Loading country: ${countryCode}`);
            
            // Show loading notification
            this.showNotification({
                type: 'info',
                message: `Loading ${countryCode}...`
            });
            
            // 백그라운드에서 Wikidata 실데이터 로드 (병렬 실행)
            // convertToISOCode가 슬러그('usa', 'south-korea')를 ISO 코드로 변환
            const wikidataPromise = territoryDataService.loadAdminDataFromWikidata(countryCode);
            
            // Load GeoJSON data
            const geoJson = await mapController.loadGeoJsonData(countryCode);
            
            if (!geoJson || !geoJson.features || geoJson.features.length === 0) {
                this.showNotification({
                    type: 'warning',
                    message: `No region data available for this country yet.`
                });
                // Still move camera
                mapController.flyToCountry(countryCode);
                return;
            }
            
            // Wikidata 로드 완료 대기 (최대 3초)
            try {
                await Promise.race([
                    wikidataPromise,
                    new Promise((_, reject) => setTimeout(() => reject('timeout'), 3000))
                ]);
            } catch (e) {
                // Wikidata 로드 실패해도 계속 진행
                log.warn('Wikidata load skipped (timeout or error)');
            }
            
            // Add territory layer
            mapController.addTerritoryLayer(`territories-${countryCode}`, geoJson);
            
            // Fly to country
            mapController.flyToCountry(countryCode);
            
            this.currentCountry = countryCode;
            
            // Success notification
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
     * Update Auth UI
     */
    updateAuthUI(user) {
        console.log('[BillionaireApp] 🎨 updateAuthUI called, user:', user ? user.email : 'null');
        
        const loginBtn = document.getElementById('side-user-login-btn');
        const logoutBtn = document.getElementById('side-user-logout-btn');
        const userEmail = document.getElementById('side-user-email');
        const headerWallet = document.getElementById('header-wallet');
        
        if (user) {
            console.log('[BillionaireApp] ✅ Updating UI for logged in user:', user.email);
            if (loginBtn) loginBtn.classList.add('hidden');
            if (logoutBtn) logoutBtn.classList.remove('hidden');
            if (userEmail) {
                userEmail.textContent = user.email;
                userEmail.classList.remove('hidden');
            }
            // 로그인 시 지갑 표시
            if (headerWallet) headerWallet.classList.remove('hidden');
        } else {
            console.log('[BillionaireApp] 👋 Updating UI for logged out user');
            if (loginBtn) loginBtn.classList.remove('hidden');
            if (logoutBtn) logoutBtn.classList.add('hidden');
            if (userEmail) userEmail.classList.add('hidden');
            // 비로그인 시 지갑 숨김
            if (headerWallet) headerWallet.classList.add('hidden');
        }
    }
    
    /**
     * 관리자 모드 여부 확인
     */
    isAdminMode() {
        const adminAuth = sessionStorage.getItem('adminAuth');
        const adminUserMode = sessionStorage.getItem('adminUserMode');
        return !!(adminAuth && adminUserMode === 'true');
    }
    
    /**
     * Show Loading
     * ⚠️ Step 6-5: 로딩 전략 고도화
     */
    showLoading() {
        const loading = document.getElementById('loading');
        if (loading) {
            loading.classList.remove('hidden');
            // ⚠️ Step 6-5: 진행률 표시 추가
            const progressBar = loading.querySelector('.loading-progress');
            if (!progressBar) {
                const progressHtml = `
                    <div class="loading-progress-container">
                        <div class="loading-progress-bar">
                            <div class="loading-progress" style="width: 0%"></div>
                        </div>
                        <div class="loading-progress-text">Initializing...</div>
                    </div>
                `;
                loading.insertAdjacentHTML('beforeend', progressHtml);
            }
        }
    }
    
    /**
     * ⚠️ Step 6-5: 로딩 진행률 업데이트
     */
    updateLoadingProgress(message, percent) {
        const loading = document.getElementById('loading');
        if (loading) {
            const progressBar = loading.querySelector('.loading-progress');
            const progressText = loading.querySelector('.loading-progress-text');
            if (progressBar) {
                progressBar.style.width = `${percent}%`;
            }
            if (progressText) {
                progressText.textContent = message || `Loading... ${percent}%`;
            }
        }
    }
    
    /**
     * Hide Loading
     */
    hideLoading() {
        const loading = document.getElementById('loading');
        if (loading) {
            loading.classList.add('hidden');
        }
    }
    
    /**
     * Show Error
     */
    showError(message) {
        const loading = document.getElementById('loading');
        if (loading) {
            loading.innerHTML = `
                <div class="error-icon">❌</div>
                <p>${message}</p>
                <button onclick="location.reload()">Refresh</button>
            `;
        }
    }
    
    /**
     * Show Notification
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
        
        // Close button
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
    
    /**
     * 피드백 버튼 초기화
     */
    initializeFeedbackButton() {
        // 이미 피드백 버튼이 있으면 제거
        const existingButton = document.getElementById('feedback-button');
        if (existingButton) {
            existingButton.remove();
        }
        
        // 피드백 버튼 생성 및 추가
        const feedbackButton = feedbackService.createFeedbackButton();
        
        // 버튼 스타일 설정
        feedbackButton.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 56px;
            height: 56px;
            border-radius: 50%;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border: none;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            cursor: pointer;
            z-index: 1000;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            transition: transform 0.2s, box-shadow 0.2s;
        `;
        
        // 호버 효과
        feedbackButton.addEventListener('mouseenter', () => {
            feedbackButton.style.transform = 'scale(1.1)';
            feedbackButton.style.boxShadow = '0 6px 16px rgba(0, 0, 0, 0.4)';
        });
        
        feedbackButton.addEventListener('mouseleave', () => {
            feedbackButton.style.transform = 'scale(1)';
            feedbackButton.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)';
        });
        
        document.body.appendChild(feedbackButton);
        log.info('[BillionaireApp] Feedback button initialized');
    }
}

// Create and initialize app instance
const app = new BillionaireApp();

// Initialize after DOM load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => app.init());
} else {
    app.init();
}

// 전역 접근용
window.BillionaireApp = app;
// Firebase Service와 MapController도 전역으로 등록 (seed 스크립트 등에서 사용)
window.firebaseService = firebaseService;
window.mapController = mapController;
export default app;



