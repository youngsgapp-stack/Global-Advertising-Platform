/**
 * PaymentService - 결제 처리 서비스
 * PayPal 결제, 결제 모달, 결제 성공/실패 처리
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { firebaseService } from './FirebaseService.js';
import { walletService, TRANSACTION_TYPE } from './WalletService.js';

// 결제 상태
export const PAYMENT_STATUS = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled'
};

// 결제 상품 타입
export const PRODUCT_TYPE = {
    POINTS: 'points',           // 포인트 충전
    TERRITORY: 'territory',     // 영토 구매
    SUBSCRIPTION: 'subscription' // 구독
};

// 포인트 패키지
export const POINT_PACKAGES = [
    { id: 'points_10', amount: 10, points: 100, label: '100 Points', bonus: 0 },
    { id: 'points_30', amount: 30, points: 350, label: '350 Points', bonus: 50, popular: true },
    { id: 'points_50', amount: 50, points: 600, label: '600 Points', bonus: 100 },
    { id: 'points_100', amount: 100, points: 1300, label: '1,300 Points', bonus: 300, best: true }
];

// 커스텀 금액 설정
export const CUSTOM_AMOUNT_CONFIG = {
    MIN_AMOUNT: 1,      // 최소 $1
    MAX_AMOUNT: 10000,  // 최대 $10,000 (상향)
    POINT_RATE: 10      // $1 = 10pt (기본 환율)
};

class PaymentService {
    constructor() {
        this.initialized = false;
        this.paypalLoaded = false;
        this.loadingPayPal = false; // PayPal SDK 로딩 중 플래그
        this.currentPayment = null;
        this.modalContainer = null;
        this.selectedPackage = null;
        this.customAmount = null;
        this.isCustomAmount = false;
        this.paypalButtonsInstance = null; // PayPal 버튼 인스턴스 추적
        this.isRenderingPayPal = false; // PayPal 버튼 렌더링 중 플래그
    }
    
    /**
     * 초기화
     */
    async initialize() {
        if (this.initialized) {
            log.info('PaymentService already initialized');
            return true;
        }
        
        try {
            // PayPal SDK는 필요할 때 로드 (결제 모달이 열릴 때)
            // 초기화 시에는 로드하지 않음 (400 오류 방지)
            
            // 결제 모달 생성
            this.createPaymentModal();
            
            // 이벤트 리스너 설정
            this.setupEventListeners();
            
            // Payoneer 리다이렉트 처리 확인 (URL 파라미터 확인)
            this.handlePayoneerReturn();
            
            this.initialized = true;
            log.info('PaymentService initialized (PayPal SDK will load on demand)');
            return true;
            
        } catch (error) {
            log.error('PaymentService initialization failed:', error);
            return false;
        }
    }
    
    /**
     * PayPal SDK 동적 로드
     */
    async loadPayPalSDK() {
        // 이미 로드되어 있으면 스킵
        if (typeof paypal !== 'undefined') {
            this.paypalLoaded = true;
            log.info('PayPal SDK already loaded');
            return true;
        }
        
        // 이미 로드 중이면 스킵
        if (this.loadingPayPal) {
            log.info('PayPal SDK already loading, waiting...');
            return false;
        }
        
        this.loadingPayPal = true;
        
        return new Promise((resolve, reject) => {
            const clientId = CONFIG.PAYPAL.CLIENT_ID;
            const currency = CONFIG.PAYPAL.CURRENCY;
            const intent = CONFIG.PAYPAL.INTENT || 'capture';
            // intent=capture 명시하여 즉시 결제 캡처 모드로 설정
            const scriptUrl = `https://www.paypal.com/sdk/js?client-id=${clientId}&currency=${currency}&intent=${intent}&vault=false`;
            
            // 스크립트가 이미 존재하는지 확인
            const existingScript = document.querySelector(`script[src*="paypal.com/sdk/js"]`);
            if (existingScript) {
                log.warn('PayPal SDK script already exists in DOM');
                this.loadingPayPal = false;
                this.checkPayPalLoaded();
                resolve(false);
                return;
            }
            
            // 스크립트 생성
            const script = document.createElement('script');
            script.src = scriptUrl;
            script.async = true;
            
            script.onload = () => {
                this.loadingPayPal = false;
                // PayPal SDK가 로드되기까지 약간의 시간이 필요할 수 있음
                setTimeout(() => {
                    if (typeof paypal !== 'undefined') {
                        this.paypalLoaded = true;
                        log.info('PayPal SDK loaded successfully');
                        resolve(true);
                    } else {
                        log.warn('PayPal SDK script loaded but paypal object not available');
                        this.checkPayPalLoaded();
                        resolve(false);
                    }
                }, 500);
            };
            
            script.onerror = (error) => {
                this.loadingPayPal = false;
                log.error('PayPal SDK script failed to load');
                log.error('URL:', scriptUrl);
                log.error('Error:', error);
                log.error('Possible causes:');
                log.error('1. Invalid Client ID - Check PayPal Developer Dashboard');
                log.error('2. Client ID mismatch between Live/Sandbox mode');
                log.error('3. PayPal app settings may have issues');
                log.error('4. Network or CORS issues');
                
                // PayPal 버튼 컨테이너에 오류 메시지 표시
                setTimeout(() => {
                    const container = document.getElementById('paypal-button-container');
                    if (container) {
                        // 기존 오류 메시지가 있으면 제거
                        const existingError = container.querySelector('.paypal-error-message');
                        if (existingError) {
                            existingError.remove();
                        }
                        
                        container.innerHTML = `
                            <div class="paypal-error-message" style="padding: 20px; text-align: center; border: 2px dashed #e74c3c; border-radius: 8px; background: #fff5f5;">
                                <div style="font-size: 32px; margin-bottom: 15px;">⚠️</div>
                                <div style="font-weight: bold; color: #e74c3c; margin-bottom: 15px; font-size: 16px;">PayPal 결제 시스템을 로드할 수 없습니다</div>
                                <div style="font-size: 13px; color: #7f8c8d; margin-bottom: 20px; line-height: 1.6; text-align: left; background: white; padding: 15px; border-radius: 6px;">
                                    <strong style="color: #2c3e50;">오류 원인:</strong><br>
                                    • Client ID가 잘못되었거나<br>
                                    • PayPal 앱이 비활성화되었거나<br>
                                    • Live/Sandbox 모드 불일치
                                </div>
                                <div style="font-size: 11px; color: #95a5a6; font-family: monospace; word-break: break-all; padding: 12px; background: #f8f9fa; border-radius: 4px; margin-bottom: 15px; border: 1px solid #e0e0e0;">
                                    <strong style="color: #7f8c8d;">현재 Client ID:</strong><br>
                                    ${clientId.substring(0, 40)}...<br>
                                    ...${clientId.substring(clientId.length - 15)}
                                </div>
                                <div style="font-size: 12px; color: #2c3e50; background: #e8f4f8; padding: 15px; border-radius: 6px; text-align: left; line-height: 1.8;">
                                    <strong style="color: #2980b9;">💡 해결 방법:</strong><br>
                                    1. <a href="https://developer.paypal.com/dashboard" target="_blank" style="color: #2980b9; text-decoration: underline;">PayPal Developer Dashboard</a> 접속<br>
                                    2. 상단에서 <strong>"Live"</strong> 모드 선택 (Sandbox 아님!)<br>
                                    3. "My Apps & Credentials" 클릭<br>
                                    4. "World Map Advertising" 앱 선택<br>
                                    5. Client ID 복사 (전체 문자열)<br>
                                    6. <code style="background: #f0f0f0; padding: 2px 6px; border-radius: 3px;">js/config.js</code> 파일의 <code style="background: #f0f0f0; padding: 2px 6px; border-radius: 3px;">PAYPAL.CLIENT_ID</code> 업데이트<br>
                                    7. 페이지 새로고침
                                </div>
                                <div style="margin-top: 15px; font-size: 11px; color: #95a5a6;">
                                    ⚠️ Client ID는 Live 모드와 Sandbox 모드가 다릅니다!
                                </div>
                            </div>
                        `;
                    }
                }, 200);
                
                eventBus.emit(EVENTS.UI_NOTIFICATION, {
                    type: 'error',
                    message: 'PayPal 결제 시스템을 로드할 수 없습니다. Client ID를 확인해주세요.'
                });
                reject(error);
            };
            
            // 스크립트 추가
            document.head.appendChild(script);
        });
    }
    
    /**
     * PayPal SDK 로드 확인
     */
    checkPayPalLoaded() {
        if (typeof paypal !== 'undefined') {
            this.paypalLoaded = true;
            log.info('PayPal SDK loaded');
        } else {
            // PayPal SDK 로딩 대기
            let checkCount = 0;
            const maxChecks = 20; // 10초 (500ms * 20)
            const checkInterval = setInterval(() => {
                checkCount++;
                if (typeof paypal !== 'undefined') {
                    this.paypalLoaded = true;
                    log.info('PayPal SDK loaded (delayed)');
                    clearInterval(checkInterval);
                } else if (checkCount >= maxChecks) {
                    clearInterval(checkInterval);
                    if (!this.paypalLoaded) {
                        log.error('PayPal SDK load timeout - Check browser console for 400 errors');
                        log.error('Possible causes:');
                        log.error('1. Invalid Client ID - Check PayPal Developer Dashboard');
                        log.error('2. PayPal SDK script failed to load (check network tab)');
                        log.error('3. CORS or network issues');
                        log.error('4. Client ID mismatch between Live/Sandbox mode');
                        eventBus.emit(EVENTS.UI_NOTIFICATION, {
                            type: 'error',
                            message: 'PayPal 결제 시스템을 로드할 수 없습니다. Client ID를 확인해주세요. (브라우저 콘솔 확인)'
                        });
                    }
                }
            }, 500);
        }
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        // 결제 시작 이벤트 핸들러
        eventBus.on(EVENTS.PAYMENT_START, (data) => {
            this.handlePaymentStart(data);
        });
    }
    
    /**
     * 관리자 모드 확인
     */
    isAdminMode() {
        const adminAuth = sessionStorage.getItem('adminAuth');
        const adminUserMode = sessionStorage.getItem('adminUserMode');
        return !!(adminAuth && adminUserMode === 'true');
    }
    
    /**
     * 결제 시작 처리
     */
    async handlePaymentStart(data) {
        const { type, territoryId, amount } = data;
        
        const user = firebaseService.getCurrentUser();
        if (!user) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: 'Please sign in to make a purchase'
            });
            eventBus.emit(EVENTS.UI_MODAL_OPEN, { type: 'login' });
            return;
        }
        
        // 관리자 모드: 잔액이 부족하면 자동으로 포인트 충전
        if (this.isAdminMode()) {
            const currentBalance = walletService.getBalance();
            if (currentBalance < amount) {
                // 부족한 포인트만큼 자동 충전
                const shortage = amount - currentBalance;
                try {
                    await walletService.addPoints(
                        shortage,
                        `Admin auto-charge for territory purchase`,
                        TRANSACTION_TYPE.ADMIN,
                        { territoryId: data.territoryId, autoCharge: true }
                    );
                    eventBus.emit(EVENTS.UI_NOTIFICATION, {
                        type: 'info',
                        message: `🔧 Admin: Auto-charged ${shortage} pt`
                    });
                } catch (error) {
                    log.error('Admin auto-charge failed:', error);
                    eventBus.emit(EVENTS.UI_NOTIFICATION, {
                        type: 'error',
                        message: 'Failed to auto-charge points'
                    });
                    return;
                }
            }
        }
        
        // 잔액 확인
        if (walletService.hasBalance(amount)) {
            // 포인트로 바로 구매
            this.openConfirmModal(data);
        } else {
            // 잔액 부족 - 충전 모달 열기
            const shortage = amount - walletService.getBalance();
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: `Insufficient balance. You need ${shortage} pt more.`
            });
            this.openChargeModal(amount);
        }
    }
    
    /**
     * 결제 모달 HTML 생성
     */
    createPaymentModal() {
        this.modalContainer = document.createElement('div');
        this.modalContainer.id = 'payment-modal';
        this.modalContainer.className = 'modal hidden';
        this.modalContainer.innerHTML = `
            <div class="modal-overlay" id="payment-modal-overlay"></div>
            <div class="modal-content payment-modal-content">
                <button class="modal-close" id="close-payment-modal">&times;</button>
                
                <!-- 충전 화면 -->
                <div id="charge-screen" class="payment-screen">
                    <div class="modal-header">
                        <h2>💰 Charge Points</h2>
                        <p>Select a package to add points to your wallet</p>
                    </div>
                    
                    <div class="current-balance">
                        <span>Current Balance:</span>
                        <strong id="modal-current-balance">0 pt</strong>
                    </div>
                    
                    <div class="point-packages" id="point-packages">
                        ${POINT_PACKAGES.map(pkg => `
                            <div class="package-card ${pkg.popular ? 'popular' : ''} ${pkg.best ? 'best' : ''}" 
                                 data-package-id="${pkg.id}"
                                 data-amount="${pkg.amount}"
                                 data-points="${pkg.points}">
                                ${pkg.popular ? '<span class="badge popular">🔥 Popular</span>' : ''}
                                ${pkg.best ? '<span class="badge best">💎 Best Value</span>' : ''}
                                <div class="package-points">${pkg.label}</div>
                                <div class="package-price">$${pkg.amount}</div>
                                ${pkg.bonus ? `<div class="package-bonus">+${pkg.bonus} bonus</div>` : ''}
                            </div>
                        `).join('')}
                    </div>
                    
                    <!-- 커스텀 금액 입력 -->
                    <div class="custom-amount-section">
                        <div class="custom-amount-divider">
                            <span>또는</span>
                        </div>
                        <div class="custom-amount-input-group">
                            <label for="custom-amount-input">💰 직접 금액 입력</label>
                            <div class="custom-amount-wrapper">
                                <span class="currency-symbol">$</span>
                                <input 
                                    type="number" 
                                    id="custom-amount-input" 
                                    class="custom-amount-input"
                                    min="${CUSTOM_AMOUNT_CONFIG.MIN_AMOUNT}"
                                    max="${CUSTOM_AMOUNT_CONFIG.MAX_AMOUNT}"
                                    step="1"
                                    placeholder="원하는 금액 입력"
                                />
                            </div>
                            <div class="custom-amount-info" id="custom-amount-info">
                                <span class="custom-points-preview">0 Points</span>
                                <span class="custom-amount-hint">(${CUSTOM_AMOUNT_CONFIG.MIN_AMOUNT} ~ ${CUSTOM_AMOUNT_CONFIG.MAX_AMOUNT})</span>
                            </div>
                        </div>
                    </div>
                    
                    <div class="payment-methods">
                        <h4>💳 Payment Method</h4>
                        
                        <!-- 카드 결제 버튼 (메인) -->
                        <div class="payment-button-group">
                            <button id="card-payment-btn" class="payment-btn payment-btn-primary payment-btn-card" disabled>
                                <span class="payment-btn-icon">💳</span>
                                <div class="payment-btn-content">
                                    <div class="payment-btn-title">카드로 간편 결제</div>
                                    <div class="payment-btn-subtitle">Visa, MasterCard, Amex, Discover, JCB</div>
                                </div>
                                <span class="payment-btn-badge">추천</span>
                            </button>
                        </div>
                        
                        <div class="payment-divider">
                            <span>또는</span>
                        </div>
                        
                        <!-- PayPal 버튼 (서브) -->
                        <div class="payment-button-group">
                            <div id="paypal-button-container"></div>
                        </div>
                    </div>
                    
                    <div class="payment-notice">
                        <small>
                            🔒 Secure payment via Payoneer Checkout & PayPal. 
                            <a href="pages/refund-policy.html" target="_blank" style="color: var(--color-primary); text-decoration: underline; cursor: pointer;">
                                환불 정책
                            </a>을 확인하세요. 포인트는 사용 전 7일 이내에만 환불 가능합니다.
                        </small>
                    </div>
                </div>
                
                <!-- 구매 확인 화면 -->
                <div id="confirm-screen" class="payment-screen hidden">
                    <div class="modal-header">
                        <h2>⚔️ Confirm Purchase</h2>
                    </div>
                    
                    <div class="purchase-summary">
                        <div class="purchase-item">
                            <span>Territory:</span>
                            <strong id="confirm-territory-name">-</strong>
                        </div>
                        <div class="purchase-item">
                            <span>Price:</span>
                            <strong id="confirm-price">0 pt</strong>
                        </div>
                        <div class="purchase-item">
                            <span>Your Balance:</span>
                            <strong id="confirm-balance">0 pt</strong>
                        </div>
                        <div class="purchase-item total">
                            <span>After Purchase:</span>
                            <strong id="confirm-remaining">0 pt</strong>
                        </div>
                    </div>
                    
                    <div class="confirm-actions">
                        <button class="btn btn-secondary" id="confirm-cancel">Cancel</button>
                        <button class="btn btn-primary" id="confirm-purchase">🏴 Own Territory</button>
                    </div>
                </div>
                
                <!-- 처리 중 화면 -->
                <div id="processing-screen" class="payment-screen hidden">
                    <div class="processing-content">
                        <div class="spinner"></div>
                        <h3>Processing...</h3>
                        <p id="processing-message">Please wait while we process your payment.</p>
                    </div>
                </div>
                
                <!-- 성공 화면 -->
                <div id="success-screen" class="payment-screen hidden">
                    <div class="success-content">
                        <div class="success-icon">🎉</div>
                        <h3>Success!</h3>
                        <p id="success-message">Your purchase was successful.</p>
                        <button class="btn btn-primary" id="success-close">Continue</button>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(this.modalContainer);
        this.bindModalEvents();
    }
    
    /**
     * 모달 이벤트 바인딩
     */
    bindModalEvents() {
        // 닫기 버튼
        document.getElementById('close-payment-modal')?.addEventListener('click', () => {
            this.closeModal();
        });
        
        // 오버레이 클릭
        document.getElementById('payment-modal-overlay')?.addEventListener('click', () => {
            this.closeModal();
        });
        
        // 패키지 선택
        document.querySelectorAll('.package-card').forEach(card => {
            card.addEventListener('click', () => {
                document.querySelectorAll('.package-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                this.selectedPackage = {
                    id: card.dataset.packageId,
                    amount: parseFloat(card.dataset.amount),
                    points: parseInt(card.dataset.points)
                };
                this.isCustomAmount = false;
                this.customAmount = null;
                
                // 커스텀 금액 입력 초기화
                const customInput = document.getElementById('custom-amount-input');
                if (customInput) {
                    customInput.value = '';
                    this.updateCustomAmountPreview(0);
                }
                
                // 결제 버튼 업데이트
                this.updatePaymentButtons();
                this.renderPayPalButton();
            });
        });
        
        // 커스텀 금액 입력
        const customAmountInput = document.getElementById('custom-amount-input');
        if (customAmountInput) {
            customAmountInput.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value) || 0;
                this.handleCustomAmountInput(value);
            });
            
            customAmountInput.addEventListener('blur', (e) => {
                const value = parseFloat(e.target.value) || 0;
                if (value > 0) {
                    this.handleCustomAmountInput(value);
                }
            });
        }
        
        // 카드 결제 버튼 이벤트
        const cardPaymentBtn = document.getElementById('card-payment-btn');
        if (cardPaymentBtn) {
            cardPaymentBtn.addEventListener('click', () => {
                this.handleCardPaymentClick();
            });
        }
        
        // 구매 확인 버튼
        document.getElementById('confirm-purchase')?.addEventListener('click', () => {
            this.processPurchase();
        });
        
        // 취소 버튼
        document.getElementById('confirm-cancel')?.addEventListener('click', () => {
            this.closeModal();
        });
        
        // 성공 닫기 버튼
        document.getElementById('success-close')?.addEventListener('click', () => {
            this.closeModal();
        });
    }
    
    /**
     * 충전 모달 열기
     */
    async openChargeModal(requiredAmount = 0) {
        // 모달 먼저 열기 (PayPal SDK 로드 실패해도 모달은 표시)
        this.showScreen('charge-screen');
        this.updateBalanceDisplay();
        this.selectedPackage = null;
        this.isCustomAmount = false;
        this.customAmount = null;
        
        // 커스텀 금액 입력 초기화
        const customInput = document.getElementById('custom-amount-input');
        if (customInput) {
            customInput.value = '';
            this.updateCustomAmountPreview(0);
        }
        
            // 적합한 패키지 자동 선택 (필요 금액보다 큰 첫 번째 패키지)
        if (requiredAmount > 0) {
            const suitablePackage = POINT_PACKAGES.find(pkg => pkg.points >= requiredAmount);
            if (suitablePackage) {
                const card = document.querySelector(`[data-package-id="${suitablePackage.id}"]`);
                if (card) {
                    card.click();
                }
            }
        }
        
        // 결제 버튼 초기 상태 업데이트
        this.updatePaymentButtons();
        
        // Payoneer 리다이렉트 처리 확인
        this.handlePayoneerReturn();
        
        this.modalContainer.classList.remove('hidden');
        
        // PayPal SDK가 로드되지 않았으면 백그라운드에서 로드 시도
        if (!this.paypalLoaded && typeof paypal === 'undefined') {
            log.info('Loading PayPal SDK on demand...');
            this.loadPayPalSDK().catch(error => {
                log.error('Failed to load PayPal SDK:', error);
                // PayPal 버튼 컨테이너에 오류 메시지 표시
                const container = document.getElementById('paypal-button-container');
                if (container) {
                    container.innerHTML = `
                        <div style="padding: 20px; text-align: center; border: 2px dashed #e74c3c; border-radius: 8px; background: #fff5f5;">
                            <div style="font-size: 24px; margin-bottom: 10px;">⚠️</div>
                            <div style="font-weight: bold; color: #e74c3c; margin-bottom: 10px;">PayPal 결제 시스템을 로드할 수 없습니다</div>
                            <div style="font-size: 12px; color: #7f8c8d; margin-bottom: 15px;">
                                Client ID를 확인해주세요.<br>
                                PayPal Developer Dashboard에서 Live 모드의 정확한 Client ID를 확인하세요.
                            </div>
                            <div style="font-size: 11px; color: #95a5a6; font-family: monospace; word-break: break-all; padding: 10px; background: #f8f9fa; border-radius: 4px;">
                                현재 Client ID:<br>
                                ${CONFIG.PAYPAL.CLIENT_ID.substring(0, 50)}...
                            </div>
                        </div>
                    `;
                }
            });
        }
    }
    
    /**
     * 구매 확인 모달 열기
     */
    openConfirmModal(purchaseData) {
        this.currentPayment = purchaseData;
        
        const balance = walletService.getBalance();
        const remaining = balance - purchaseData.amount;
        
        document.getElementById('confirm-territory-name').textContent = 
            purchaseData.territoryName || purchaseData.territoryId;
        document.getElementById('confirm-price').textContent = `${purchaseData.amount} pt`;
        document.getElementById('confirm-balance').textContent = `${balance} pt`;
        document.getElementById('confirm-remaining').textContent = `${remaining} pt`;
        
        this.showScreen('confirm-screen');
        this.modalContainer.classList.remove('hidden');
    }
    
    /**
     * 화면 전환
     */
    showScreen(screenId) {
        // 충전 화면이 아닌 다른 화면으로 전환할 때 PayPal 버튼 정리
        if (screenId !== 'charge-screen') {
            this.cleanupPayPalButtons();
        }
        
        document.querySelectorAll('.payment-screen').forEach(screen => {
            screen.classList.add('hidden');
        });
        document.getElementById(screenId)?.classList.remove('hidden');
    }
    
    /**
     * 모달 닫기
     */
    closeModal() {
        // PayPal 버튼 정리
        this.cleanupPayPalButtons();
        
        if (this.modalContainer) {
            this.modalContainer.classList.add('hidden');
        }
        
        this.currentPayment = null;
        this.selectedPackage = null;
        this.isCustomAmount = false;
        this.customAmount = null;
        
        // 커스텀 금액 입력 초기화
        const customInput = document.getElementById('custom-amount-input');
        if (customInput) {
            customInput.value = '';
            this.updateCustomAmountPreview(0);
        }
    }
    
    /**
     * PayPal 버튼 정리
     */
    cleanupPayPalButtons() {
        try {
            const container = document.getElementById('paypal-button-container');
            if (container) {
                container.innerHTML = '';
            }
            this.paypalButtonsInstance = null;
        } catch (error) {
            log.warn('Error cleaning up PayPal buttons:', error);
            this.paypalButtonsInstance = null;
        }
    }
    
    /**
     * 잔액 표시 업데이트
     */
    updateBalanceDisplay() {
        const balance = walletService.getBalance();
        document.getElementById('modal-current-balance').textContent = `${balance.toLocaleString()} pt`;
    }
    
    /**
     * 커스텀 금액 입력 처리
     */
    handleCustomAmountInput(value) {
        if (value <= 0) {
            this.updateCustomAmountPreview(0);
            this.isCustomAmount = false;
            this.customAmount = null;
            this.selectedPackage = null;
            
            // 패키지 선택 해제
            document.querySelectorAll('.package-card').forEach(c => c.classList.remove('selected'));
            
            // PayPal 버튼 제거
            const container = document.getElementById('paypal-button-container');
            if (container) {
                container.innerHTML = '';
            }
            
            // 결제 버튼 업데이트
            this.updatePaymentButtons();
            return;
        }
        
        // 최소/최대 금액 검증
        const minAmount = CUSTOM_AMOUNT_CONFIG.MIN_AMOUNT;
        const maxAmount = CUSTOM_AMOUNT_CONFIG.MAX_AMOUNT;
        
        if (value < minAmount) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: `최소 금액은 $${minAmount}입니다.`
            });
            return;
        }
        
        if (value > maxAmount) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: `최대 금액은 $${maxAmount}입니다.`
            });
            return;
        }
        
        // 패키지 선택 해제
        document.querySelectorAll('.package-card').forEach(c => c.classList.remove('selected'));
        
        // 커스텀 금액 설정
        this.isCustomAmount = true;
        this.customAmount = value;
        this.selectedPackage = null;
        
        // 포인트 계산 (기본 환율: $1 = 10pt)
        const points = Math.floor(value * CUSTOM_AMOUNT_CONFIG.POINT_RATE);
        this.updateCustomAmountPreview(points);
        
        // 결제 버튼 업데이트
        this.updatePaymentButtons();
        // PayPal 버튼 렌더링
        this.renderPayPalButton();
    }
    
    /**
     * 커스텀 금액 미리보기 업데이트
     */
    updateCustomAmountPreview(points) {
        const previewEl = document.querySelector('.custom-points-preview');
        if (previewEl) {
            previewEl.textContent = `${points.toLocaleString()} Points`;
        }
    }
    
    /**
     * 카드 결제 버튼 클릭 처리
     */
    async handleCardPaymentClick() {
        // 선택된 패키지 또는 커스텀 금액 확인
        if (!this.selectedPackage && !this.customAmount) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: 'Please select a package or enter a custom amount'
            });
            return;
        }
        
        let amount, points;
        
        if (this.isCustomAmount && this.customAmount) {
            amount = this.customAmount;
            points = Math.floor(amount * CUSTOM_AMOUNT_CONFIG.POINT_RATE);
        } else if (this.selectedPackage) {
            amount = this.selectedPackage.amount;
            points = this.selectedPackage.points;
        } else {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: 'Please select a package or enter a custom amount'
            });
            return;
        }
        
        // 금액 검증
        if (amount < CUSTOM_AMOUNT_CONFIG.MIN_AMOUNT || amount > CUSTOM_AMOUNT_CONFIG.MAX_AMOUNT) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: `Invalid amount. Please enter between $${CUSTOM_AMOUNT_CONFIG.MIN_AMOUNT} and $${CUSTOM_AMOUNT_CONFIG.MAX_AMOUNT}.`
            });
            return;
        }
        
        // Payoneer Checkout 시작
        await this.initiatePayoneerCheckout(amount, points);
    }
    
    /**
     * 결제 버튼 활성화/비활성화 업데이트
     */
    updatePaymentButtons() {
        const cardBtn = document.getElementById('card-payment-btn');
        const hasSelection = this.selectedPackage || this.customAmount;
        
        if (cardBtn) {
            if (hasSelection) {
                cardBtn.disabled = false;
                cardBtn.classList.remove('disabled');
            } else {
                cardBtn.disabled = true;
                cardBtn.classList.add('disabled');
            }
        }
    }
    
    /**
     * PayPal 버튼 렌더링
     */
    renderPayPalButton() {
        // 이미 렌더링 중이면 스킵 (중복 렌더링 방지)
        if (this.isRenderingPayPal) {
            log.warn('PayPal button is already being rendered, skipping...');
            return;
        }
        
        // PayPal SDK 로드 확인
        if (typeof paypal === 'undefined') {
            log.warn('PayPal SDK not loaded yet, waiting...');
            // PayPal SDK 로드 대기 후 재시도 (최대 5회)
            let retryCount = 0;
            const maxRetries = 5;
            const checkPayPal = setInterval(() => {
                retryCount++;
                if (typeof paypal !== 'undefined') {
                    this.paypalLoaded = true;
                    clearInterval(checkPayPal);
                    this.renderPayPalButton();
                } else if (retryCount >= maxRetries) {
                    clearInterval(checkPayPal);
                    log.error('PayPal SDK failed to load after retries');
                    eventBus.emit(EVENTS.UI_NOTIFICATION, {
                        type: 'error',
                        message: 'PayPal payment system is not available. Please refresh the page.'
                    });
                }
            }, 1000);
            return;
        }
        
        if (!this.paypalLoaded) {
            this.paypalLoaded = true;
        }
        
        // paypal.Buttons가 사용 가능한지 확인
        if (typeof paypal.Buttons !== 'function') {
            log.error('paypal.Buttons is not available');
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: 'PayPal buttons are not available. Please refresh the page.'
            });
            return;
        }
        
        // 컨테이너가 DOM에 존재하는지 확인
        const container = document.getElementById('paypal-button-container');
        if (!container) {
            log.warn('PayPal button container not found in DOM');
            return;
        }
        
        // 모달이 닫혀있으면 버튼 렌더링 안 함
        if (this.modalContainer && this.modalContainer.classList.contains('hidden')) {
            return;
        }
        
        // 선택된 패키지 또는 커스텀 금액이 없으면 버튼 렌더링 안 함
        if (!this.selectedPackage && !this.customAmount) {
            if (container) {
                container.innerHTML = '';
            }
            this.paypalButtonsInstance = null;
            return;
        }
        
        // 기존 PayPal 버튼 인스턴스 완전히 정리
        if (this.paypalButtonsInstance) {
            try {
                // PayPal 버튼 인스턴스가 있으면 완전히 정리
                if (container && container.isConnected) {
                    container.innerHTML = '';
                }
                // 인스턴스 정리 (close 메서드가 있으면 호출)
                if (typeof this.paypalButtonsInstance.close === 'function') {
                    try {
                        this.paypalButtonsInstance.close();
                    } catch (e) {
                        // close()가 실패해도 무시
                    }
                }
            } catch (error) {
                log.warn('Error cleaning up PayPal buttons:', error);
            }
            this.paypalButtonsInstance = null;
        }
        
        // 컨테이너가 여전히 DOM에 존재하는지 재확인
        const currentContainer = document.getElementById('paypal-button-container');
        if (!currentContainer || !currentContainer.isConnected) {
            log.warn('PayPal button container removed from DOM before rendering');
            return;
        }
        
        // 컨테이너 내용 비우기 (안전하게)
        if (currentContainer && currentContainer.isConnected) {
            currentContainer.innerHTML = '';
        }
        
        // 결제 정보 결정
        let amount, points, description;
        
        if (this.isCustomAmount && this.customAmount) {
            amount = this.customAmount;
            points = Math.floor(amount * CUSTOM_AMOUNT_CONFIG.POINT_RATE);
            description = `Own a Piece of Earth - ${points.toLocaleString()} Points (Custom)`;
        } else if (this.selectedPackage) {
            amount = this.selectedPackage.amount;
            points = this.selectedPackage.points;
            description = `Own a Piece of Earth - ${points.toLocaleString()} Points`;
        } else {
            return;
        }
        
        // 컨테이너가 여전히 DOM에 존재하는지 최종 확인
        const verifyContainer = document.getElementById('paypal-button-container');
        if (!verifyContainer || !verifyContainer.isConnected) {
            log.warn('PayPal button container removed from DOM after cleanup');
            return;
        }
        
        try {
            // 금액 검증 (최소 $1, 최대 $10,000)
            if (amount < 1 || amount > CUSTOM_AMOUNT_CONFIG.MAX_AMOUNT) {
                log.error('Invalid payment amount:', amount);
                eventBus.emit(EVENTS.UI_NOTIFICATION, {
                    type: 'error',
                    message: `Invalid payment amount. Please enter between $1 and $${CUSTOM_AMOUNT_CONFIG.MAX_AMOUNT.toLocaleString()}.`
                });
                return;
            }
            
            log.info('Rendering PayPal button...', {
                amount: amount,
                points: points,
                description: description
            });
            
            // PayPal 버튼 생성 전 로깅
            console.log('🔵 [PayPal] ============================================');
            console.log('🔵 [PayPal] PayPal 버튼 생성 시작');
            console.log('🔵 [PayPal] Amount:', amount);
            console.log('🔵 [PayPal] Points:', points);
            console.log('🔵 [PayPal] ============================================');
            
            // PayPal 버튼 생성 전에 글로벌 이벤트 리스너 추가 (디버깅용)
            if (!window.__paypalEventListenersAdded) {
                window.__paypalEventListenersAdded = true;
                
                // 페이지 포커스 이벤트 (PayPal에서 돌아올 때)
                window.addEventListener('focus', () => {
                    console.log('🟡 [PayPal] Window focused - PayPal에서 돌아왔을 수 있음');
                    console.log('🟡 [PayPal] onApprove called:', window.__paypalOnApproveCalled);
                });
                
                // 메시지 이벤트 (PayPal iframe 통신)
                window.addEventListener('message', (event) => {
                    if (event.origin.includes('paypal.com') || event.origin.includes('paypalobjects.com')) {
                        console.log('🟡 [PayPal] Message from PayPal:', event.origin, event.data);
                    }
                });
                
                // 페이지 언로드 이벤트
                window.addEventListener('beforeunload', () => {
                    console.log('🟡 [PayPal] Page unloading');
                });
            }
            
            this.paypalButtonsInstance = paypal.Buttons({
                style: {
                    layout: 'vertical',
                    color: 'gold',
                    shape: 'rect',
                    label: 'pay'
                },
                
                createOrder: async (data, actions) => {
                    console.log('🔵 [PayPal] ============================================');
                    console.log('🔵 [PayPal] createOrder 콜백 호출됨!');
                    console.log('🔵 [PayPal] Data:', data);
                    console.log('🔵 [PayPal] Actions:', actions ? 'available' : 'null');
                    console.log('🔵 [PayPal] ============================================');
                    try {
                        // PayPal은 소수점 2자리까지 지원하므로 정확히 포맷팅
                        const formattedAmount = parseFloat(amount).toFixed(2);
                        
                        log.info('Creating PayPal order via server API...', {
                            amount: formattedAmount,
                            description: description
                        });
                        
                        // 서버 API로 Order 생성 (통합 API 사용)
                        const response = await fetch('/api/paypal', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                action: 'create-order',
                                amount: formattedAmount,
                                currency: 'USD',
                                description: description
                            })
                        });
                        
                        if (!response.ok) {
                            const errorData = await response.json();
                            throw new Error(errorData.error || 'Failed to create PayPal order');
                        }
                        
                        const result = await response.json();
                        
                        if (!result.success || !result.orderID) {
                            throw new Error(result.error || 'Invalid response from server');
                        }
                        
                        console.log('🔵 [PayPal] ============================================');
                        console.log('🔵 [PayPal] ✅ Order 생성 성공!');
                        console.log('🔵 [PayPal] Order ID:', result.orderID);
                        console.log('🔵 [PayPal] 이제 사용자가 PayPal에서 결제를 승인하면 onApprove가 호출됩니다.');
                        console.log('🔵 [PayPal] ============================================');
                        log.info('PayPal order created successfully via server:', { orderID: result.orderID });
                        
                        return result.orderID;
                        
                    } catch (error) {
                        console.error('🔴 [PayPal] ============================================');
                        console.error('🔴 [PayPal] ❌ Order 생성 실패!');
                        console.error('🔴 [PayPal] Error:', error);
                        console.error('🔴 [PayPal] ============================================');
                        log.error('PayPal createOrder failed:', {
                            error: error.message || error,
                            stack: error.stack,
                            errorType: error.constructor?.name
                        });
                        throw error;
                    }
                },
                
                onApprove: async (data, actions) => {
                    // ============================================
                    // 단계 1: PayPal 콜백 진입 확인
                    // ============================================
                    // 즉시 콘솔에 출력 (디버그 모드와 무관하게 항상 표시)
                    console.log('🔵🔵🔵 [PayPal] ============================================');
                    console.log('🔵🔵🔵 [PayPal] ⚠️⚠️⚠️ onApprove 콜백 호출됨! ⚠️⚠️⚠️');
                    console.log('🔵🔵🔵 [PayPal] Order ID:', data.orderID);
                    console.log('🔵🔵🔵 [PayPal] Payer ID:', data.payerID);
                    console.log('🔵🔵🔵 [PayPal] Full data:', JSON.stringify(data, null, 2));
                    console.log('🔵🔵🔵 [PayPal] Actions available:', !!actions);
                    console.log('🔵🔵🔵 [PayPal] Timestamp:', new Date().toISOString());
                    console.log('🔵🔵🔵 [PayPal] Current URL:', window.location.href);
                    console.log('🔵🔵🔵 [PayPal] ============================================');
                    
                    // 글로벌 변수에 저장 (디버깅용)
                    window.__paypalOnApproveCalled = true;
                    window.__paypalOnApproveData = data;
                    window.__paypalOnApproveTimestamp = new Date().toISOString();
                    
                    const step1Log = {
                        step: '1/3',
                        stage: 'PayPal 콜백 진입',
                        orderID: data.orderID,
                        payerID: data.payerID,
                        timestamp: new Date().toISOString()
                    };
                    
                    if (CONFIG.DEBUG.PAYMENT_VERBOSE) {
                        console.log('🔵 [PayPal] ============================================');
                        console.log('🔵 [PayPal] 단계 1/3: onApprove 콜백 진입');
                        console.log('🔵 [PayPal]', step1Log);
                        console.log('🔵 [PayPal] ============================================');
                    }
                    log.info('[PayPal] Step 1/3: onApprove callback entered', step1Log);
                    
                    this.showScreen('processing-screen');
                    const processingMsg = document.getElementById('processing-message');
                    if (processingMsg) {
                        processingMsg.textContent = 'Completing your payment...';
                    }
                    
                    try {
                        // ============================================
                        // 단계 2: 서버 API로 PayPal Capture 요청
                        // ============================================
                        const step2Log = {
                            step: '2/3',
                            stage: 'PayPal Capture 요청 (서버 API)',
                            orderID: data.orderID,
                            timestamp: new Date().toISOString()
                        };
                        
                        if (CONFIG.DEBUG.PAYMENT_VERBOSE) {
                            console.log('🔵 [PayPal] ============================================');
                            console.log('🔵 [PayPal] 단계 2/3: 서버 API로 Capture 요청 시작');
                            console.log('🔵 [PayPal]', step2Log);
                            console.log('🔵 [PayPal] ============================================');
                        }
                        log.info('[PayPal] Step 2/3: Starting capture request via server API', step2Log);
                        
                        // 사용자 정보 가져오기
                        const user = firebaseService.getCurrentUser();
                        if (!user) {
                            throw new Error('User not authenticated');
                        }
                        
                        // 서버 API로 Capture 요청 (통합 API 사용)
                        const captureResponse = await fetch('/api/paypal', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                action: 'capture-order',
                                orderID: data.orderID,
                                userId: user.uid,
                                amount: amount,
                                points: points
                            })
                        });
                        
                        if (!captureResponse.ok) {
                            const errorData = await captureResponse.json();
                            throw new Error(errorData.error || 'Failed to capture PayPal order');
                        }
                        
                        const captureResult = await captureResponse.json();
                        
                        if (!captureResult.success) {
                            throw new Error(captureResult.error || 'Capture failed');
                        }
                        
                        const step2SuccessLog = {
                            step: '2/3',
                            stage: 'PayPal Capture 성공 (서버 API)',
                            orderID: captureResult.orderID,
                            status: captureResult.status,
                            points: captureResult.points,
                            timestamp: new Date().toISOString()
                        };
                        
                        if (CONFIG.DEBUG.PAYMENT_VERBOSE) {
                            console.log('🔵 [PayPal] ============================================');
                            console.log('🔵 [PayPal] 단계 2/3: Capture 성공');
                            console.log('🔵 [PayPal]', step2SuccessLog);
                            console.log('🔵 [PayPal] ============================================');
                        }
                        log.info('[PayPal] Step 2/3: Capture successful via server API', step2SuccessLog);
                        
                        // ============================================
                        // 단계 3: UI 업데이트 및 완료 처리
                        // ============================================
                        const step3Log = {
                            step: '3/3',
                            stage: 'UI 업데이트 및 완료',
                            orderID: captureResult.orderID,
                            amount: amount,
                            points: points,
                            timestamp: new Date().toISOString()
                        };
                        
                        if (CONFIG.DEBUG.PAYMENT_VERBOSE) {
                            console.log('🔵 [PayPal] ============================================');
                            console.log('🔵 [PayPal] 단계 3/3: UI 업데이트 시작');
                            console.log('🔵 [PayPal]', step3Log);
                            console.log('🔵 [PayPal] ============================================');
                        }
                        log.info('[PayPal] Step 3/3: Updating UI', step3Log);
                        
                        // 서버에서 이미 포인트 충전을 완료했으므로, 지갑 새로고침만 필요
                        await walletService.refreshBalance();
                        
                        // 성공 화면 표시
                        this.showScreen('success-screen');
                        const successMsg = document.getElementById('success-message');
                        if (successMsg) {
                            successMsg.textContent = `${points.toLocaleString()} points have been added to your wallet!`;
                        }
                        
                        // 성공 이벤트 발행
                        eventBus.emit(EVENTS.PAYMENT_SUCCESS, {
                            type: PRODUCT_TYPE.POINTS,
                            amount: amount,
                            points: points,
                            isCustomAmount: this.isCustomAmount,
                            method: 'paypal'
                        });
                        
                        eventBus.emit(EVENTS.UI_NOTIFICATION, {
                            type: 'success',
                            message: `${points.toLocaleString()} points added! 🎉`
                        });
                        
                        // 커스텀 금액 초기화
                        this.isCustomAmount = false;
                        this.customAmount = null;
                        this.selectedPackage = null;
                        
                        if (CONFIG.DEBUG.PAYMENT_VERBOSE) {
                            console.log('🔵 [PayPal] ============================================');
                            console.log('🔵 [PayPal] 단계 3/3: UI 업데이트 완료');
                            console.log('🔵 [PayPal] 모든 단계 성공적으로 완료!');
                            console.log('🔵 [PayPal] ============================================');
                        }
                        log.info('[PayPal] Step 3/3: UI update completed successfully');
                        
                    } catch (error) {
                        // 오류 발생 시 어느 단계에서 실패했는지 명확히 표시
                        const errorLog = {
                            error: error.message || String(error),
                            errorName: error.name || error.constructor?.name,
                            errorCode: error.code,
                            orderID: data.orderID,
                            stack: CONFIG.DEBUG.PAYMENT_VERBOSE ? error.stack : undefined,
                            timestamp: new Date().toISOString()
                        };
                        
                        if (CONFIG.DEBUG.PAYMENT_VERBOSE) {
                            console.error('🔴 [PayPal] ============================================');
                            console.error('🔴 [PayPal] 결제 처리 실패');
                            console.error('🔴 [PayPal]', errorLog);
                            console.error('🔴 [PayPal] ============================================');
                        }
                        log.error('[PayPal] Payment processing failed', errorLog);
                        
                        this.handlePaymentError(error, data.orderID);
                    }
                },
                
                onCancel: (data) => {
                    console.log('🟡 [PayPal] ============================================');
                    console.log('🟡 [PayPal] ⚠️⚠️⚠️ onCancel 콜백 호출됨! ⚠️⚠️⚠️');
                    console.log('🟡 [PayPal] Cancel data:', data);
                    console.log('🟡 [PayPal] Full cancel data:', JSON.stringify(data, null, 2));
                    console.log('🟡 [PayPal] Current URL:', window.location.href);
                    console.log('🟡 [PayPal] Timestamp:', new Date().toISOString());
                    console.log('🟡 [PayPal] ============================================');
                    
                    // 글로벌 변수에 저장 (디버깅용)
                    window.__paypalOnCancelCalled = true;
                    window.__paypalOnCancelData = data;
                    window.__paypalOnCancelTimestamp = new Date().toISOString();
                    
                    eventBus.emit(EVENTS.UI_NOTIFICATION, {
                        type: 'info',
                        message: 'Payment cancelled'
                    });
                    this.showScreen('charge-screen');
                },
                
                onError: (err) => {
                    console.error('🔴🔴🔴 [PayPal] ============================================');
                    console.error('🔴🔴🔴 [PayPal] ⚠️⚠️⚠️ onError 콜백 호출됨! ⚠️⚠️⚠️');
                    console.error('🔴🔴🔴 [PayPal] Error object:', err);
                    console.error('🔴🔴🔴 [PayPal] Error message:', err.message || String(err));
                    console.error('🔴🔴🔴 [PayPal] Error name:', err.name);
                    console.error('🔴🔴🔴 [PayPal] Error type:', err.constructor?.name);
                    console.error('🔴🔴🔴 [PayPal] Error stack:', err.stack);
                    console.error('🔴🔴🔴 [PayPal] Full error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
                    console.error('🔴🔴🔴 [PayPal] Current URL:', window.location.href);
                    console.error('🔴🔴🔴 [PayPal] Timestamp:', new Date().toISOString());
                    console.error('🔴🔴🔴 [PayPal] ============================================');
                    
                    // 글로벌 변수에 저장 (디버깅용)
                    window.__paypalOnErrorCalled = true;
                    window.__paypalOnErrorData = err;
                    window.__paypalOnErrorTimestamp = new Date().toISOString();
                    
                    log.error('PayPal button error:', {
                        error: err.message || err,
                        errorName: err.name,
                        errorType: err.constructor?.name,
                        stack: err.stack,
                        details: err,
                        errorString: String(err),
                        fullError: JSON.stringify(err, Object.getOwnPropertyNames(err), 2)
                    });
                    eventBus.emit(EVENTS.UI_NOTIFICATION, {
                        type: 'error',
                        message: `PayPal 결제 오류: ${err.message || '알 수 없는 오류가 발생했습니다.'}`
                    });
                    this.handlePaymentError(err);
                }
            });
            
            // 렌더링 전에 컨테이너 존재 여부 최종 확인 및 DOM 안정화 대기
            const finalContainer = document.getElementById('paypal-button-container');
            console.log('🔵 [PayPal] ============================================');
            console.log('🔵 [PayPal] 렌더링 전 컨테이너 확인...');
            console.log('🔵 [PayPal] Container element:', finalContainer);
            console.log('🔵 [PayPal] Container exists:', !!finalContainer);
            console.log('🔵 [PayPal] Container connected:', finalContainer?.isConnected);
            console.log('🔵 [PayPal] Container innerHTML length:', finalContainer?.innerHTML?.length || 0);
            console.log('🔵 [PayPal] PayPal SDK available:', typeof paypal !== 'undefined');
            console.log('🔵 [PayPal] paypal.Buttons available:', typeof paypal?.Buttons === 'function');
            console.log('🔵 [PayPal] Buttons instance:', this.paypalButtonsInstance);
            console.log('🔵 [PayPal] ============================================');
            
            if (!finalContainer || !finalContainer.isConnected) {
                console.error('🔴 [PayPal] 컨테이너가 DOM에 없거나 연결되지 않음!');
                log.warn('PayPal button container removed from DOM during render setup');
                this.paypalButtonsInstance = null;
                return;
            }
            
            if (!this.paypalButtonsInstance) {
                console.error('🔴 [PayPal] PayPal 버튼 인스턴스가 없음!');
                log.error('PayPal buttons instance is null');
                return;
            }
            
            // DOM이 안정화될 때까지 짧은 딜레이 후 렌더링
            // 이렇게 하면 다른 코드가 컨테이너를 조작하는 것을 방지할 수 있음
            this.isRenderingPayPal = true; // 렌더링 시작 플래그 설정
            
            setTimeout(() => {
                // 렌더링 직전에 다시 한 번 컨테이너 확인
                const renderContainer = document.getElementById('paypal-button-container');
                if (!renderContainer || !renderContainer.isConnected) {
                    console.error('🔴 [PayPal] 렌더링 직전에 컨테이너가 DOM에서 제거됨!');
                    log.warn('PayPal button container removed from DOM just before rendering');
                    this.paypalButtonsInstance = null;
                    this.isRenderingPayPal = false; // 렌더링 실패 시 플래그 해제
                    return;
                }
                
                // 버튼 렌더링
                log.info('Rendering PayPal button to container...');
                console.log('🔵 [PayPal] ============================================');
                console.log('🔵 [PayPal] 버튼 렌더링 시작...');
                console.log('🔵 [PayPal] Container ID: #paypal-button-container');
                console.log('🔵 [PayPal] Container verified:', renderContainer.isConnected);
                console.log('🔵 [PayPal] ============================================');
                
                this.paypalButtonsInstance.render('#paypal-button-container').then(() => {
                    this.isRenderingPayPal = false; // 렌더링 완료 시 플래그 해제
                console.log('✅✅✅ [PayPal] ============================================');
                console.log('✅✅✅ [PayPal] 버튼 렌더링 성공!');
                console.log('✅✅✅ [PayPal] ============================================');
                log.info('✅ PayPal button rendered successfully');
            }).catch(error => {
                this.isRenderingPayPal = false; // 렌더링 실패 시 플래그 해제
                console.error('🔴🔴🔴 [PayPal] ============================================');
                console.error('🔴🔴🔴 [PayPal] ❌ 버튼 렌더링 실패!');
                console.error('🔴🔴🔴 [PayPal] Error object:', error);
                console.error('🔴🔴🔴 [PayPal] Error message:', error.message || String(error));
                console.error('🔴🔴🔴 [PayPal] Error name:', error.name);
                console.error('🔴🔴🔴 [PayPal] Error stack:', error.stack);
                console.error('🔴🔴🔴 [PayPal] Error details:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
                console.error('🔴🔴🔴 [PayPal] Error type:', error.constructor?.name);
                console.error('🔴🔴🔴 [PayPal] Full error:', error);
                console.error('🔴🔴🔴 [PayPal] ============================================');
                
                log.error('❌ PayPal button render failed:', {
                    error: error.message || error,
                    errorName: error.name,
                    errorType: error.constructor?.name,
                    stack: error.stack,
                    details: error,
                    fullError: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
                });
                
                const container = document.getElementById('paypal-button-container');
                if (container) {
                    container.innerHTML = `
                        <div style="padding: 20px; text-align: center; color: #e74c3c; border: 2px dashed #e74c3c; border-radius: 8px;">
                            <p style="font-weight: bold; margin-bottom: 10px;">PayPal 버튼을 렌더링할 수 없습니다</p>
                            <p style="font-size: 12px; margin-bottom: 10px;">${error.message || '알 수 없는 오류'}</p>
                            <p style="font-size: 11px; color: #7f8c8d; margin-top: 10px;">
                                브라우저 콘솔을 확인하여 상세 오류 정보를 확인하세요.
                            </p>
                        </div>
                    `;
                }
                });
            }, 100); // 100ms 딜레이로 DOM 안정화 대기
            
        } catch (error) {
            this.isRenderingPayPal = false; // 렌더링 실패 시 플래그 해제
            log.error('Failed to render PayPal button:', {
                error: error.message || error,
                stack: error.stack,
                details: error
            });
            this.paypalButtonsInstance = null;
            const container = document.getElementById('paypal-button-container');
            if (container) {
                container.innerHTML = `
                    <div style="padding: 20px; text-align: center; color: #e74c3c;">
                        <p>PayPal 버튼 생성 중 오류가 발생했습니다.</p>
                        <p style="font-size: 12px;">${error.message || '알 수 없는 오류'}</p>
                    </div>
                `;
            }
        }
    }
    
    /**
     * 공통 결제 성공 처리 핸들러
     * PayPal과 Payoneer 모두 이 핸들러를 통해 포인트를 지급합니다
     */
    async handlePaymentSuccess(paymentData) {
        const {
            transactionId,
            method, // 'paypal' | 'card'
            amount,
            points,
            payerId = null,
            paymentDetails = {},
            validation = {}
        } = paymentData;
        
        const user = firebaseService.getCurrentUser();
        if (!user) {
            throw new Error('User not authenticated');
        }
        
        log.info('[Payment] Processing payment success (common handler)...', {
            transactionId: transactionId,
            method: method,
            amount: amount,
            points: points,
            userId: user.uid
        });
        
        // ⚠️ CRITICAL: Transaction을 사용하여 중복 결제 방지 강화
        const Timestamp = firebaseService.getTimestamp();
        const paymentDocId = `payment_${transactionId}`;
        
        // Transaction으로 결제 로그 저장 및 중복 체크를 원자적으로 처리
        let paymentRecord;
        try {
            paymentRecord = await firebaseService.runTransaction(async (transaction) => {
                // Transaction 내에서 중복 체크 (최신 상태 보장)
                const existingPayment = await transaction.get('payments', paymentDocId);
                
                if (existingPayment) {
                    if (existingPayment.pointStatus === 'completed') {
                        log.warn('[Payment] 🔒 Transaction: Duplicate payment detected - already processed', {
                            transactionId: transactionId,
                            existingStatus: existingPayment.status,
                            existingPointStatus: existingPayment.pointStatus
                        });
                        throw new Error(`이미 처리된 결제입니다. 주문번호: ${transactionId}`);
                    } else if (existingPayment.pointStatus === 'pending') {
                        log.info('[Payment] 🔒 Transaction: Retrying payment processing for pending order', {
                            transactionId: transactionId
                        });
                        // pending 상태인 경우 기존 레코드 업데이트
                        const updatedRecord = {
                            ...existingPayment,
                            processingStage: 'retry',
                            updatedAt: Timestamp ? Timestamp.now() : new Date()
                        };
                        transaction.update('payments', paymentDocId, updatedRecord);
                        return updatedRecord;
                    }
                }
                
                // 새 결제 레코드 생성
                const newRecord = {
                    transactionId: transactionId,
                    method: method,
                    amount: amount,
                    points: points,
                    isCustomAmount: this.isCustomAmount,
                    status: PAYMENT_STATUS.COMPLETED,
                    pointStatus: 'pending',
                    processingStage: 'validation',
                    userId: user.uid,
                    createdAt: Timestamp ? Timestamp.now() : new Date(),
                    updatedAt: Timestamp ? Timestamp.now() : new Date(),
                    paymentDetails: paymentDetails,
                    validation: validation,
                    ...(method === 'paypal' ? { paypalOrderId: transactionId, paypalPayerId: payerId } : {}),
                    ...(method === 'card' ? { payoneerTransactionId: transactionId } : {})
                };
                
                transaction.set('payments', paymentDocId, newRecord);
                log.info('[Payment] 🔒 Transaction: Payment record created in transaction', {
                    transactionId: transactionId,
                    method: method
                });
                
                return newRecord;
            });
            
            log.info('[Payment] ✅ Transaction completed: Payment record saved', {
                transactionId: transactionId,
                method: method,
                status: paymentRecord.status
            });
        } catch (transactionError) {
            if (transactionError.message && transactionError.message.includes('이미 처리된')) {
                // 중복 결제 - 사용자에게 명확한 메시지
                throw transactionError;
            }
            
            log.error('[Payment] ❌ Transaction failed, falling back to regular save:', transactionError);
            // Fallback: 기존 방식으로 저장 시도
            paymentRecord = {
                transactionId: transactionId,
                method: method,
                amount: amount,
                points: points,
                isCustomAmount: this.isCustomAmount,
                status: PAYMENT_STATUS.COMPLETED,
                pointStatus: 'pending',
                processingStage: 'validation',
                userId: user.uid,
                createdAt: Timestamp ? Timestamp.now() : new Date(),
                updatedAt: Timestamp ? Timestamp.now() : new Date(),
                paymentDetails: paymentDetails,
                validation: validation,
                ...(method === 'paypal' ? { paypalOrderId: transactionId, paypalPayerId: payerId } : {}),
                ...(method === 'card' ? { payoneerTransactionId: transactionId } : {})
            };
            
            await firebaseService.setDocument('payments', paymentDocId, paymentRecord);
        }
        
        // 포인트 충전 (Transaction으로 보호)
        try {
            await firebaseService.updateDocument(
                'payments',
                paymentDocId,
                { 
                    processingStage: 'points',
                    updatedAt: Timestamp ? Timestamp.now() : new Date()
                }
            );
            
            const methodName = method === 'paypal' ? 'PayPal' : 'Card';
            await walletService.addPoints(
                points,
                `${methodName} charge: $${amount}${this.isCustomAmount ? ' (Custom)' : ''}`,
                TRANSACTION_TYPE.CHARGE,
                { 
                    transactionId: transactionId,
                    method: method,
                    isCustomAmount: this.isCustomAmount 
                }
            );
            
            await firebaseService.updateDocument(
                'payments',
                paymentDocId,
                { 
                    pointStatus: 'completed',
                    processingStage: 'completed',
                    updatedAt: Timestamp ? Timestamp.now() : new Date()
                }
            );
            
            log.info('[Payment] Points added to wallet successfully', {
                transactionId: transactionId,
                points: points,
                method: method
            });
            
            // 성공 화면 표시
            this.showScreen('success-screen');
            document.getElementById('success-message').textContent = 
                `${points.toLocaleString()} points have been added to your wallet!`;
            
            // 성공 이벤트 발행
            eventBus.emit(EVENTS.PAYMENT_SUCCESS, {
                type: PRODUCT_TYPE.POINTS,
                amount: amount,
                points: points,
                isCustomAmount: this.isCustomAmount,
                method: method
            });
            
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'success',
                message: `${points.toLocaleString()} points added! 🎉`
            });
            
            // 커스텀 금액 초기화
            this.isCustomAmount = false;
            this.customAmount = null;
            this.selectedPackage = null;
            
        } catch (walletError) {
            log.error('[Payment] Failed to add points to wallet:', walletError);
            
            await firebaseService.updateDocument(
                'payments',
                `payment_${transactionId}`,
                { 
                    pointStatus: 'failed',
                    processingStage: 'points_failed',
                    pointError: walletError.message,
                    updatedAt: Timestamp ? Timestamp.now() : new Date()
                }
            );
            
            throw new Error(`결제는 완료되었지만 포인트 반영에 실패했습니다. 주문번호: ${transactionId}. 관리자에게 문의해주세요.`);
        }
    }
    
    /**
     * PayPal 결제 성공 처리
     * 전문가 조언 반영: 결제 로그 저장과 포인트 반영을 분리
     * 이제 공통 핸들러를 사용합니다
     */
    async handlePayPalSuccess(details, amount, points) {
        const user = firebaseService.getCurrentUser();
        if (!user) {
            throw new Error('User not authenticated');
        }
        
        const orderID = details.id;
        
        // PayPal 응답 검증
        const successStatuses = ['COMPLETED', 'APPROVED', 'PENDING'];
        const isPaymentSuccessful = successStatuses.includes(details.status) || 
                                   details.status === 'COMPLETED' ||
                                   (details.purchase_units?.[0]?.payments?.captures?.[0]?.status === 'COMPLETED');
        
        const capturedAmount = parseFloat(details.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value || 0);
        const amountMatches = Math.abs(capturedAmount - amount) < 0.01;
        const isNotFailed = !['CANCELLED', 'FAILED', 'VOIDED', 'DENIED'].includes(details.status);
        
        // 공통 핸들러 사용
        await this.handlePaymentSuccess({
            transactionId: orderID,
            method: 'paypal',
            amount: amount,
            points: points,
            payerId: details.payer?.payer_id,
            paymentDetails: {
                status: details.status,
                payer: details.payer,
                purchase_units: details.purchase_units,
                fullResponse: CONFIG.DEBUG.PAYMENT ? details : undefined
            },
            validation: {
                isPaymentSuccessful,
                amountMatches,
                isNotFailed,
                capturedAmount,
                expectedAmount: amount
            }
        });
    }
    
    /**
     * 포인트로 영토 구매 처리
     */
    async processPurchase() {
        if (!this.currentPayment) return;
        
        const user = firebaseService.getCurrentUser();
        if (!user) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: 'Please sign in first'
            });
            return;
        }
        
        this.showScreen('processing-screen');
        document.getElementById('processing-message').textContent = 'Processing your purchase...';
        
        try {
            // 포인트 차감 (관리자도 일반 사용자와 동일하게 차감)
            await walletService.deductPoints(
                this.currentPayment.amount,
                `Territory purchase: ${this.currentPayment.territoryName || this.currentPayment.territoryId}`,
                TRANSACTION_TYPE.PURCHASE,
                { territoryId: this.currentPayment.territoryId }
            );
            
            // 구매 성공 이벤트 발행 (영토 정복 처리)
            eventBus.emit(EVENTS.PAYMENT_SUCCESS, {
                type: PRODUCT_TYPE.TERRITORY,
                territoryId: this.currentPayment.territoryId,
                amount: this.currentPayment.amount,
                protectionDays: this.currentPayment.protectionDays || null, // 보호 기간 전달
                isAdmin: false // 관리자도 일반 구매로 처리
            });
            
            // 성공 화면
            this.showScreen('success-screen');
            document.getElementById('success-message').textContent = 
                `You now own ${this.currentPayment.territoryName || 'this territory'}! 🎉`;
            
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'success',
                message: 'Territory purchased successfully! 🎉'
            });
            
        } catch (error) {
            log.error('Purchase failed:', error);
            
            // ⚠️ 사용자 친화적 에러 메시지
            let errorMessage = '구매 처리에 실패했습니다.';
            let errorType = 'error';
            
            if (error.message?.includes('Insufficient') || error.message?.includes('balance')) {
                // 잔액 부족 - 충전 화면으로
                this.openChargeModal(this.currentPayment.amount);
                errorMessage = `❌ 잔액이 부족합니다. ${this.currentPayment.amount} pt가 필요합니다.`;
                errorType = 'warning';
            } else if (error.message?.includes('already owned') || error.message?.includes('already ruled')) {
                errorMessage = '⚠️ 이 영토는 이미 다른 사용자가 구매했습니다. 잔액은 환불됩니다.';
                errorType = 'warning';
                // 포인트 환불
                try {
                    await walletService.addPoints(
                        this.currentPayment.amount,
                        `Refund: Territory already owned`,
                        TRANSACTION_TYPE.BID_REFUND,
                        { territoryId: this.currentPayment.territoryId, reason: 'already_owned' }
                    );
                } catch (refundError) {
                    log.error('Failed to refund points:', refundError);
                }
            } else if (error.message?.includes('Auction in progress')) {
                errorMessage = '⚠️ 이 영토는 현재 경매 중입니다.';
                errorType = 'warning';
            } else if (error.message?.includes('network') || error.message?.includes('offline')) {
                errorMessage = '🌐 네트워크 연결을 확인하고 다시 시도해주세요.';
                errorType = 'error';
            } else if (error.message?.includes('Ownership changed')) {
                errorMessage = '⚠️ 구매 중 소유권이 변경되었습니다. 잔액은 환불됩니다.';
                errorType = 'warning';
                // 포인트 환불
                try {
                    await walletService.addPoints(
                        this.currentPayment.amount,
                        `Refund: Ownership changed during purchase`,
                        TRANSACTION_TYPE.BID_REFUND,
                        { territoryId: this.currentPayment.territoryId, reason: 'ownership_changed' }
                    );
                } catch (refundError) {
                    log.error('Failed to refund points:', refundError);
                }
            }
            
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: errorType,
                message: errorMessage
            });
            
            // 일반 에러 처리
            if (errorType === 'error') {
                this.handlePaymentError(error);
            }
        }
    }
    
    /**
     * 결제 오류를 Firestore에 로깅
     */
    async logPaymentErrorToFirestore(orderID, errorInfo) {
        if (!orderID) return;
        
        try {
            const Timestamp = firebaseService.getTimestamp();
            const errorLog = {
                orderID: orderID,
                ...errorInfo,
                timestamp: Timestamp ? Timestamp.now() : new Date(),
                userAgent: navigator.userAgent,
                url: window.location.href
            };
            
            await firebaseService.setDocument(
                'paymentErrors',
                `error_${orderID}_${Date.now()}`,
                errorLog
            );
            
            log.info('[Payment] Error log saved to Firestore', {
                orderID: orderID,
                stage: errorInfo.stage
            });
        } catch (logError) {
            log.error('[Payment] Failed to save error log to Firestore:', logError);
        }
    }
    
    /**
     * 결제 오류 처리
     * 전문가 조언 반영: 실패 = 무조건 에러가 아니라 "결제는 됐을 수도 있음" 메시지
     */
    handlePaymentError(error, orderID = null) {
        const errorLog = {
            error: error.message || String(error),
            errorName: error.name || error.constructor?.name,
            errorCode: error.code,
            orderID: orderID,
            stack: CONFIG.DEBUG.PAYMENT ? error.stack : undefined,
            timestamp: new Date().toISOString()
        };
        
        log.error('[Payment] Payment error:', errorLog);
        
        this.showScreen('charge-screen');
        
        // 사용자 친화적인 오류 메시지
        let errorMessage = 'Payment failed. Please try again.';
        let isPartialSuccess = false; // 결제는 됐지만 포인트 반영 실패
        
        if (error.message) {
            // 결제는 완료되었지만 포인트 반영 실패한 경우
            if (error.message.includes('결제는 완료되었지만') || 
                error.message.includes('결제가 완료되었지만') ||
                error.message.includes('주문번호')) {
                isPartialSuccess = true;
                errorMessage = error.message; // 전문가 조언대로 orderID 포함 메시지 그대로 사용
            } else if (error.message.includes('network') || error.message.includes('Network')) {
                errorMessage = 'Network error. Please check your connection and try again.';
            } else if (error.message.includes('permission') || error.message.includes('Permission')) {
                errorMessage = 'Permission denied. Please check your account settings.';
            } else if (error.message.includes('insufficient') || error.message.includes('balance')) {
                errorMessage = 'Insufficient funds. Please check your PayPal account balance.';
            } else if (error.message.includes('cancelled') || error.message.includes('cancel')) {
                errorMessage = 'Payment was cancelled.';
            } else if (error.message.includes('timeout')) {
                errorMessage = 'Payment timed out. Please try again.';
            } else {
                // 상세한 오류 메시지 (디버그 모드일 때만)
                if (CONFIG.DEBUG.PAYMENT) {
                    errorMessage = `Payment failed: ${error.message}${orderID ? ` (Order ID: ${orderID})` : ''}`;
                } else {
                    errorMessage = `Payment failed. ${orderID ? `Order ID: ${orderID}. ` : ''}Please contact support if the issue persists.`;
                }
            }
        } else if (orderID) {
            // orderID가 있으면 결제는 진행됐을 가능성이 있음
            isPartialSuccess = true;
            errorMessage = `결제 처리 중 오류가 발생했습니다. 주문번호: ${orderID}. 결제는 완료되었을 수 있으니 잠시 후 포인트를 확인해주세요. 문제가 지속되면 관리자에게 문의해주세요.`;
        }
        
        // 디버그 모드일 때 상세 정보 표시
        if (CONFIG.DEBUG.PAYMENT && orderID) {
            console.error('[Payment] Error details:', {
                orderID: orderID,
                error: errorLog,
                isPartialSuccess: isPartialSuccess
            });
        }
        
        // 에러 로그를 Firestore에 저장 (비동기, 실패해도 계속 진행)
        if (orderID) {
            this.logPaymentErrorToFirestore(orderID, {
                stage: 'error_handling',
                error: error.message || String(error),
                errorName: error.name || error.constructor?.name,
                errorCode: error.code,
                isPartialSuccess: isPartialSuccess,
                stack: CONFIG.DEBUG.PAYMENT ? error.stack : undefined
            }).catch(logError => {
                log.error('[Payment] Failed to save error log:', logError);
            });
        }
        
        eventBus.emit(EVENTS.PAYMENT_ERROR, { error, orderID, isPartialSuccess });
        eventBus.emit(EVENTS.UI_NOTIFICATION, {
            type: isPartialSuccess ? 'warning' : 'error',
            message: errorMessage
        });
    }
    
    /**
     * Payoneer Checkout으로 카드 결제 시작
     */
    async initiatePayoneerCheckout(amount, points) {
        const user = firebaseService.getCurrentUser();
        if (!user) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: 'Please sign in to make a payment'
            });
            eventBus.emit(EVENTS.UI_MODAL_OPEN, { type: 'login' });
            return;
        }
        
        // Payoneer 설정 확인
        if (!CONFIG.PAYONEER.MERCHANT_ID || !CONFIG.PAYONEER.API_KEY) {
            log.error('[Payment] Payoneer not configured');
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: 'Card payment is not available. Please contact support.'
            });
            return;
        }
        
        try {
            this.showScreen('processing-screen');
            document.getElementById('processing-message').textContent = 
                'Initializing card payment...';
            
            // 결제 정보 준비
            const transactionId = `payoneer_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const description = `Own a Piece of Earth - ${points.toLocaleString()} Points${this.isCustomAmount ? ' (Custom)' : ''}`;
            
            // Return URL 동적 생성
            const returnUrl = window.location.origin + window.location.pathname;
            const cancelUrl = window.location.origin + window.location.pathname;
            
            // Payoneer Checkout URL 생성
            // 실제 구현 시 서버 API를 통해 Checkout Session을 생성해야 합니다
            // 여기서는 클라이언트 사이드에서 직접 호출하는 방식으로 구현합니다
            const checkoutParams = new URLSearchParams({
                merchantId: CONFIG.PAYONEER.MERCHANT_ID,
                amount: amount.toFixed(2),
                currency: CONFIG.PAYONEER.CURRENCY,
                description: description,
                transactionId: transactionId,
                returnUrl: returnUrl,
                cancelUrl: cancelUrl,
                userId: user.uid,
                points: points.toString(),
                isCustomAmount: this.isCustomAmount.toString()
            });
            
            // Payoneer Checkout 페이지로 리다이렉트
            // 실제 구현 시 Payoneer API를 통해 세션을 생성하고 리다이렉트해야 합니다
            const checkoutUrl = `${CONFIG.PAYONEER.CHECKOUT_URL}/checkout?${checkoutParams.toString()}`;
            
            log.info('[Payment] Initiating Payoneer Checkout', {
                transactionId: transactionId,
                amount: amount,
                points: points,
                userId: user.uid
            });
            
            // 현재 창에서 리다이렉트
            window.location.href = checkoutUrl;
            
        } catch (error) {
            log.error('[Payment] Payoneer Checkout initiation failed:', error);
            this.handlePaymentError(error);
        }
    }
    
    /**
     * Payoneer 결제 성공 처리 (리다이렉트 콜백에서 호출)
     * URL 파라미터에서 결제 정보를 받아 처리합니다
     */
    async handlePayoneerReturn() {
        const urlParams = new URLSearchParams(window.location.search);
        const status = urlParams.get('status');
        const transactionId = urlParams.get('transactionId');
        const amount = parseFloat(urlParams.get('amount') || '0');
        const points = parseInt(urlParams.get('points') || '0');
        
        // URL에서 파라미터 제거 (깔끔한 URL 유지)
        if (status || transactionId) {
            const newUrl = window.location.pathname;
            window.history.replaceState({}, document.title, newUrl);
        }
        
        if (status === 'success' && transactionId && amount > 0 && points > 0) {
            try {
                this.showScreen('processing-screen');
                document.getElementById('processing-message').textContent = 
                    'Processing your payment...';
                
                // 공통 핸들러 사용
                await this.handlePaymentSuccess({
                    transactionId: transactionId,
                    method: 'card',
                    amount: amount,
                    points: points,
                    paymentDetails: {
                        status: status,
                        returnParams: Object.fromEntries(urlParams.entries())
                    },
                    validation: {
                        isPaymentSuccessful: true,
                        amountMatches: true,
                        isNotFailed: true
                    }
                });
                
            } catch (error) {
                log.error('[Payment] Payoneer return processing failed:', error);
                this.handlePaymentError(error, transactionId);
            }
        } else if (status === 'cancel') {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'info',
                message: 'Payment was cancelled'
            });
            this.showScreen('charge-screen');
        }
    }
    
    /**
     * 관리자: 결제 내역 조회
     */
    async getPaymentHistory(userId = null, limit = 50) {
        try {
            const conditions = userId ? [{ field: 'userId', op: '==', value: userId }] : [];
            return await firebaseService.queryCollection(
                'payments',
                conditions,
                { field: 'createdAt', direction: 'desc' },
                limit
            );
        } catch (error) {
            log.error('Failed to get payment history:', error);
            return [];
        }
    }
    
    /**
     * 정리
     */
    cleanup() {
        this.cleanupPayPalButtons();
        
        if (this.modalContainer) {
            this.modalContainer.remove();
        }
        this.initialized = false;
    }
}

// 싱글톤 인스턴스
export const paymentService = new PaymentService();
export default paymentService;

