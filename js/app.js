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
            
            // Firebase 초기화 후 현재 사용자 상태 확인 (리다이렉트 후 복원)
            setTimeout(() => {
                const currentUser = firebaseService.getCurrentUser();
                if (currentUser) {
                    console.log('[BillionaireApp] 🔍 Found existing user after init:', currentUser.email);
                    this.updateAuthUI(currentUser);
                }
            }, 1000);
            
            await territoryDataService.initialize();
            
            // 2.5. Initialize Wallet & Payment Services
            await walletService.initialize();
            await paymentService.initialize();
            
            // 3. Initialize Map
            await mapController.initialize('map');
            
            // 4. Initialize Territory Manager
            await territoryManager.initialize();
            
            // 5. Initialize Feature Systems
            await Promise.all([
                auctionSystem.initialize(),
                rankingSystem.initialize(),
                buffSystem.initialize(),
                collaborationHub.initialize(),
                historyLogger.initialize(),
                recommendationSystem.initialize()
            ]);
            
            // 6. Initialize UI
            territoryPanel.initialize();
            territoryListPanel.initialize();
            pixelEditor3.initialize();
            rankingBoard.initialize();
            timelineWidget.initialize();
            recommendationPanel.initialize();
            onboardingGuide.initialize();
            this.initializeUI();
            
            // 7. Setup Event Listeners
            this.setupEventListeners();
            
            // 8. Load Initial Data
            await this.loadInitialData();
            
            // 9. Hide loading
            this.hideLoading();
            
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
    }
    
    /**
     * 관리자 사용자 모드 체크 및 배너 표시
     */
    checkAdminUserMode() {
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
            
            log.info('관리자 사용자 모드 활성화');
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
                mapController.clearAllTerritoryLayers();
                
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
        eventBus.on(EVENTS.AUTH_STATE_CHANGED, ({ user }) => {
            console.log('[BillionaireApp] 🔐 AUTH_STATE_CHANGED event received, user:', user ? user.email : 'null');
            this.updateAuthUI(user);
        });
        
        // Notification event
        eventBus.on(EVENTS.UI_NOTIFICATION, (data) => {
            this.showNotification(data);
        });
        
        // Wallet balance update
        eventBus.on(WALLET_EVENTS.BALANCE_UPDATED, ({ balance }) => {
            this.updateWalletUI(balance);
        });
        
        // Payment success - handle territory conquest
        eventBus.on(EVENTS.PAYMENT_SUCCESS, async (data) => {
            const user = firebaseService.getCurrentUser();
            if (user && data.territoryId) {
                await auctionSystem.instantConquest(
                    data.territoryId,
                    user.uid,
                    user.displayName || user.email
                );
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
            rankingBoard.open();
            rankingBoard.switchTab('territories');
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
                        <p>Click the <strong>💰 Wallet</strong> button to charge points via PayPal. Points are used to claim territories and place auction bids.</p>
                        <ul>
                            <li>$10 → 1,000 pt</li>
                            <li>$25 → 2,750 pt (+10% bonus)</li>
                            <li>$50 → 6,000 pt (+20% bonus)</li>
                        </ul>
                    </div>
                    
                    <div class="help-section">
                        <h3>🏴 3. Claim Territories</h3>
                        <p>Click on an unclaimed territory and hit <strong>"Claim Now"</strong> to instantly own it. Each territory has a unique price based on population and area.</p>
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
                        <p>Own a Piece of Earth is an interactive global territory game where players can claim, auction, and decorate real-world administrative regions. Build your empire, compete with others, and leave your mark on the world!</p>
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
     * Update Wallet UI
     */
    updateWalletUI(balance) {
        const walletDisplay = document.getElementById('wallet-balance');
        if (walletDisplay) {
            walletDisplay.textContent = `${balance.toLocaleString()} pt`;
        }
        
        const headerWallet = document.getElementById('header-wallet-balance');
        if (headerWallet) {
            headerWallet.textContent = `${balance.toLocaleString()} pt`;
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
            
            // 1,2,3: Zoom levels
            if (e.key === '1') mapController.flyTo([0, 20], 2);
            if (e.key === '2') mapController.flyTo([0, 20], 4);
            if (e.key === '3') mapController.flyTo([0, 20], 6);
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
     */
    showLoading() {
        const loading = document.getElementById('loading');
        if (loading) {
            loading.classList.remove('hidden');
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
export default app;

