/**
 * Billionaire Homepage v2 - Main Application
 * App Entry Point & Initialization
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
import { recommendationSystem } from './features/RecommendationSystem.js';
import { recommendationPanel } from './ui/RecommendationPanel.js';
import { territoryDataService } from './services/TerritoryDataService.js';

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
            await territoryDataService.initialize();
            
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
            pixelEditor.initialize();
            rankingBoard.initialize();
            timelineWidget.initialize();
            recommendationPanel.initialize();
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
            this.updateAuthUI(user);
        });
        
        // Notification event
        eventBus.on(EVENTS.UI_NOTIFICATION, (data) => {
            this.showNotification(data);
        });
        
        // Payment success
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
            document.getElementById('admin-id')?.focus();
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
            document.getElementById('admin-id').value = '';
            document.getElementById('admin-pwd').value = '';
            document.getElementById('admin-login-error')?.classList.add('hidden');
        }
    }
    
    /**
     * Handle Admin Login
     */
    async handleAdminLogin() {
        const adminId = document.getElementById('admin-id')?.value?.trim();
        const adminPwd = document.getElementById('admin-pwd')?.value;
        const errorEl = document.getElementById('admin-login-error');
        
        // 하드코딩된 관리자 계정 (실제 운영에서는 Firebase Auth 사용 권장)
        const ADMIN_CREDENTIALS = {
            'admin': 'billionaire2024!',
            'young91': 'admin1234!'
        };
        
        if (ADMIN_CREDENTIALS[adminId] && ADMIN_CREDENTIALS[adminId] === adminPwd) {
            // 로그인 성공 - admin.html로 이동
            this.showNotification({
                type: 'success',
                message: '✅ Admin login successful!'
            });
            
            // 세션 스토리지에 관리자 상태 저장
            sessionStorage.setItem('adminAuth', JSON.stringify({
                id: adminId,
                timestamp: Date.now()
            }));
            
            this.closeAdminModal();
            
            // admin.html로 이동
            setTimeout(() => {
                window.location.href = 'admin.html';
            }, 500);
        } else {
            // 로그인 실패
            if (errorEl) {
                errorEl.textContent = '❌ Invalid ID or password';
                errorEl.classList.remove('hidden');
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

