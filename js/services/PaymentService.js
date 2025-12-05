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
    MAX_AMOUNT: 1000,   // 최대 $1000
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
        
        // 관리자 모드: 무료 구매 (바로 확인 모달로)
        if (this.isAdminMode()) {
            this.openConfirmModal({ ...data, isAdmin: true });
            return;
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
                        <div id="paypal-button-container"></div>
                    </div>
                    
                    <div class="payment-notice">
                        <small>🔒 Secure payment via PayPal. Points are non-refundable.</small>
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
                        <button class="btn btn-primary" id="confirm-purchase">⚔️ Claim Territory</button>
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
     * PayPal 버튼 렌더링
     */
    renderPayPalButton() {
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
        
        // 기존 PayPal 버튼 정리
        if (this.paypalButtonsInstance) {
            try {
                // PayPal 버튼 인스턴스가 있으면 정리
                container.innerHTML = '';
            } catch (error) {
                log.warn('Error cleaning up PayPal buttons:', error);
            }
            this.paypalButtonsInstance = null;
        } else {
            container.innerHTML = ''; // 기존 버튼 제거
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
        
        // 컨테이너가 여전히 DOM에 존재하는지 재확인
        const currentContainer = document.getElementById('paypal-button-container');
        if (!currentContainer || !currentContainer.isConnected) {
            log.warn('PayPal button container removed from DOM before rendering');
            return;
        }
        
        try {
            // 금액 검증 (최소 $1, 최대 $1000)
            if (amount < 1 || amount > 1000) {
                log.error('Invalid payment amount:', amount);
                eventBus.emit(EVENTS.UI_NOTIFICATION, {
                    type: 'error',
                    message: `Invalid payment amount. Please enter between $1 and $1000.`
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
            
            this.paypalButtonsInstance = paypal.Buttons({
                style: {
                    layout: 'vertical',
                    color: 'gold',
                    shape: 'rect',
                    label: 'pay'
                },
                
                createOrder: (data, actions) => {
                    console.log('🔵 [PayPal] ============================================');
                    console.log('🔵 [PayPal] createOrder 콜백 호출됨!');
                    console.log('🔵 [PayPal] Data:', data);
                    console.log('🔵 [PayPal] Actions:', actions ? 'available' : 'null');
                    console.log('🔵 [PayPal] ============================================');
                    try {
                        // PayPal은 소수점 2자리까지 지원하므로 정확히 포맷팅
                        const formattedAmount = parseFloat(amount).toFixed(2);
                        
                        log.info('Creating PayPal order...', {
                            amount: formattedAmount,
                            description: description,
                            actions: actions ? 'available' : 'null'
                        });
                        
                        const orderPromise = actions.order.create({
                            purchase_units: [{
                                description: description,
                                amount: {
                                    value: formattedAmount,
                                    currency_code: 'USD'
                                }
                            }]
                        });
                        
                        orderPromise.then(orderID => {
                            console.log('🔵 [PayPal] ============================================');
                            console.log('🔵 [PayPal] ✅ Order 생성 성공!');
                            console.log('🔵 [PayPal] Order ID:', orderID);
                            console.log('🔵 [PayPal] 이제 사용자가 PayPal에서 결제를 승인하면 onApprove가 호출됩니다.');
                            console.log('🔵 [PayPal] ============================================');
                            log.info('PayPal order created successfully:', { orderID });
                        }).catch(error => {
                            console.error('🔴 [PayPal] ============================================');
                            console.error('🔴 [PayPal] ❌ Order 생성 실패!');
                            console.error('🔴 [PayPal] Error:', error);
                            console.error('🔴 [PayPal] ============================================');
                            log.error('PayPal createOrder failed:', {
                                error: error.message || error,
                                stack: error.stack,
                                details: error,
                                errorType: error.constructor?.name
                            });
                        });
                        
                        return orderPromise;
                    } catch (error) {
                        log.error('Error in createOrder (catch block):', {
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
                    console.log('🔵🔵🔵 [PayPal] ⚠️ onApprove 콜백 호출됨!');
                    console.log('🔵🔵🔵 [PayPal] Order ID:', data.orderID);
                    console.log('🔵🔵🔵 [PayPal] Payer ID:', data.payerID);
                    console.log('🔵🔵🔵 [PayPal] Timestamp:', new Date().toISOString());
                    console.log('🔵🔵🔵 [PayPal] ============================================');
                    
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
                        // 단계 2: PayPal SDK Capture 요청
                        // ============================================
                        const step2Log = {
                            step: '2/3',
                            stage: 'PayPal Capture 요청',
                            orderID: data.orderID,
                            timestamp: new Date().toISOString()
                        };
                        
                        if (CONFIG.DEBUG.PAYMENT_VERBOSE) {
                            console.log('🔵 [PayPal] ============================================');
                            console.log('🔵 [PayPal] 단계 2/3: Capture 요청 시작');
                            console.log('🔵 [PayPal]', step2Log);
                            console.log('🔵 [PayPal] ============================================');
                        }
                        log.info('[PayPal] Step 2/3: Starting capture request', step2Log);
                        
                        // PayPal 결제 캡처
                        const details = await actions.order.capture();
                        
                        const step2SuccessLog = {
                            step: '2/3',
                            stage: 'PayPal Capture 성공',
                            orderID: details.id,
                            status: details.status,
                            payerID: details.payer?.payer_id,
                            amount: details.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value,
                            currency: details.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.currency_code,
                            timestamp: new Date().toISOString(),
                            fullResponse: CONFIG.DEBUG.PAYMENT_VERBOSE ? details : undefined
                        };
                        
                        if (CONFIG.DEBUG.PAYMENT_VERBOSE) {
                            console.log('🔵 [PayPal] ============================================');
                            console.log('🔵 [PayPal] 단계 2/3: Capture 성공');
                            console.log('🔵 [PayPal]', step2SuccessLog);
                            console.log('🔵 [PayPal] ============================================');
                        }
                        log.info('[PayPal] Step 2/3: Capture successful', step2SuccessLog);
                        
                        // ============================================
                        // 단계 3: 비즈니스 로직 실행 (포인트 충전)
                        // ============================================
                        const step3Log = {
                            step: '3/3',
                            stage: '비즈니스 로직 실행',
                            orderID: details.id,
                            amount: amount,
                            points: points,
                            timestamp: new Date().toISOString()
                        };
                        
                        if (CONFIG.DEBUG.PAYMENT_VERBOSE) {
                            console.log('🔵 [PayPal] ============================================');
                            console.log('🔵 [PayPal] 단계 3/3: 포인트 충전 로직 시작');
                            console.log('🔵 [PayPal]', step3Log);
                            console.log('🔵 [PayPal] ============================================');
                        }
                        log.info('[PayPal] Step 3/3: Starting business logic', step3Log);
                        
                        // 결제 성공 - 포인트 충전
                        await this.handlePayPalSuccess(details, amount, points);
                        
                        if (CONFIG.DEBUG.PAYMENT_VERBOSE) {
                            console.log('🔵 [PayPal] ============================================');
                            console.log('🔵 [PayPal] 단계 3/3: 포인트 충전 완료');
                            console.log('🔵 [PayPal] 모든 단계 성공적으로 완료!');
                            console.log('🔵 [PayPal] ============================================');
                        }
                        log.info('[PayPal] Step 3/3: Business logic completed successfully');
                        
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
                
                onCancel: () => {
                    console.log('🟡 [PayPal] ============================================');
                    console.log('🟡 [PayPal] ⚠️ onCancel 콜백 호출됨!');
                    console.log('🟡 [PayPal] 사용자가 결제를 취소했습니다.');
                    console.log('🟡 [PayPal] ============================================');
                    
                    eventBus.emit(EVENTS.UI_NOTIFICATION, {
                        type: 'info',
                        message: 'Payment cancelled'
                    });
                    this.showScreen('charge-screen');
                },
                
                onError: (err) => {
                    console.error('🔴🔴🔴 [PayPal] ============================================');
                    console.error('🔴🔴🔴 [PayPal] ⚠️ onError 콜백 호출됨!');
                    console.error('🔴🔴🔴 [PayPal] Error:', err);
                    console.error('🔴🔴🔴 [PayPal] Error message:', err.message || String(err));
                    console.error('🔴🔴🔴 [PayPal] Error type:', err.constructor?.name);
                    console.error('🔴🔴🔴 [PayPal] ============================================');
                    
                    log.error('PayPal button error:', {
                        error: err.message || err,
                        errorType: err.constructor?.name,
                        stack: err.stack,
                        details: err,
                        errorString: String(err)
                    });
                    eventBus.emit(EVENTS.UI_NOTIFICATION, {
                        type: 'error',
                        message: `PayPal 결제 오류: ${err.message || '알 수 없는 오류가 발생했습니다.'}`
                    });
                    this.handlePaymentError(err);
                }
            });
            
            // 렌더링 전에 컨테이너 존재 여부 최종 확인
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
            
            // 버튼 렌더링
            log.info('Rendering PayPal button to container...');
            console.log('🔵 [PayPal] ============================================');
            console.log('🔵 [PayPal] 버튼 렌더링 시작...');
            console.log('🔵 [PayPal] Container ID: #paypal-button-container');
            console.log('🔵 [PayPal] ============================================');
            
            this.paypalButtonsInstance.render('#paypal-button-container').then(() => {
                console.log('✅✅✅ [PayPal] ============================================');
                console.log('✅✅✅ [PayPal] 버튼 렌더링 성공!');
                console.log('✅✅✅ [PayPal] ============================================');
                log.info('✅ PayPal button rendered successfully');
            }).catch(error => {
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
            
        } catch (error) {
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
     * PayPal 결제 성공 처리
     * 전문가 조언 반영: 결제 로그 저장과 포인트 반영을 분리
     */
    async handlePayPalSuccess(details, amount, points) {
        const user = firebaseService.getCurrentUser();
        if (!user) {
            throw new Error('User not authenticated');
        }
        
        const orderID = details.id;
        
        log.info('[Payment] Processing PayPal payment success...', {
            orderID: orderID,
            amount: amount,
            points: points,
            userId: user.uid,
            paypalStatus: details.status
        });
        
        // 중복 결제 방지: 이미 처리된 orderID인지 확인
        try {
            const existingPayment = await firebaseService.getDocument('payments', `payment_${orderID}`);
            if (existingPayment) {
                // 이미 처리된 결제인 경우
                if (existingPayment.pointStatus === 'completed') {
                    log.warn('[Payment] Duplicate payment detected - already processed', {
                        orderID: orderID,
                        existingStatus: existingPayment.status,
                        existingPointStatus: existingPayment.pointStatus
                    });
                    throw new Error(`이미 처리된 결제입니다. 주문번호: ${orderID}`);
                } else if (existingPayment.pointStatus === 'pending') {
                    // PENDING 상태인 경우 재처리 시도
                    log.info('[Payment] Retrying payment processing for pending order', {
                        orderID: orderID
                    });
                }
            }
        } catch (error) {
            // 문서가 없으면 정상 (새로운 결제)
            if (!error.message?.includes('not found') && !error.message?.includes('does not exist')) {
                log.warn('[Payment] Error checking duplicate payment:', error);
                // 중복 체크 실패해도 계속 진행 (네트워크 오류 등)
            }
        }
        
        // Firestore Timestamp 가져오기
        const Timestamp = firebaseService.getTimestamp();
        
        // PayPal 응답 검증 완화: COMPLETED 외에도 성공 가능한 상태 허용
        const successStatuses = ['COMPLETED', 'APPROVED', 'PENDING'];
        const isPaymentSuccessful = successStatuses.includes(details.status) || 
                                   details.status === 'COMPLETED' ||
                                   (details.purchase_units?.[0]?.payments?.captures?.[0]?.status === 'COMPLETED');
        
        // 결제 금액 검증 (1차 기준)
        const capturedAmount = parseFloat(details.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value || 0);
        const amountMatches = Math.abs(capturedAmount - amount) < 0.01; // 소수점 오차 허용
        
        // 결제 상태 검증 (2차 기준: 명백히 실패/취소가 아닌지)
        const isNotFailed = !['CANCELLED', 'FAILED', 'VOIDED', 'DENIED'].includes(details.status);
        
        // 결제 로그는 항상 저장 (포인트 반영과 분리)
        const paymentRecord = {
            paypalOrderId: orderID,
            paypalPayerId: details.payer?.payer_id,
            amount: amount,
            capturedAmount: capturedAmount,
            points: points,
            isCustomAmount: this.isCustomAmount,
            status: isPaymentSuccessful && amountMatches && isNotFailed 
                ? PAYMENT_STATUS.COMPLETED 
                : PAYMENT_STATUS.PENDING, // 애매한 경우 PENDING으로 기록
            pointStatus: 'pending', // 포인트 반영 상태 (pending/completed/failed)
            processingStage: 'validation', // 처리 단계 추적 (validation -> saving -> points -> completed)
            userId: user.uid,
            createdAt: Timestamp ? Timestamp.now() : new Date(),
            updatedAt: Timestamp ? Timestamp.now() : new Date(),
            paypalDetails: {
                status: details.status,
                payer: details.payer,
                purchase_units: details.purchase_units,
                // 전체 응답 저장 (디버깅용)
                fullResponse: CONFIG.DEBUG.PAYMENT ? details : undefined
            },
            validation: {
                isPaymentSuccessful,
                amountMatches,
                isNotFailed,
                capturedAmount,
                expectedAmount: amount
            }
        };
        
        // 1단계: 결제 로그 저장 (항상 실행)
        try {
            paymentRecord.processingStage = 'saving';
            await firebaseService.setDocument(
                'payments',
                `payment_${orderID}`,
                paymentRecord
            );
            log.info('[Payment] Payment record saved to Firestore', {
                orderID: orderID,
                status: paymentRecord.status,
                pointStatus: paymentRecord.pointStatus
            });
        } catch (firestoreError) {
            log.error('[Payment] Failed to save payment record to Firestore:', firestoreError);
            
            // 에러 로그도 Firestore에 저장 시도
            try {
                await this.logPaymentErrorToFirestore(orderID, {
                    stage: 'saving_payment_record',
                    error: firestoreError.message || String(firestoreError),
                    errorName: firestoreError.name,
                    stack: CONFIG.DEBUG.PAYMENT ? firestoreError.stack : undefined
                });
            } catch (logError) {
                log.error('[Payment] Failed to save error log:', logError);
            }
            
            // Firestore 저장 실패는 치명적이므로 재시도
            throw new Error(`Failed to save payment record: ${firestoreError.message}`);
        }
        
        // 2단계: 포인트 충전 (검증 통과 시에만)
        if (isPaymentSuccessful && amountMatches && isNotFailed) {
            try {
                // 처리 단계 업데이트
                await firebaseService.updateDocument(
                    'payments',
                    `payment_${orderID}`,
                    { 
                        processingStage: 'points',
                        updatedAt: Timestamp ? Timestamp.now() : new Date()
                    }
                );
                
                await walletService.addPoints(
                    points,
                    `PayPal charge: $${amount}${this.isCustomAmount ? ' (Custom)' : ''}`,
                    TRANSACTION_TYPE.CHARGE,
                    { paypalOrderId: orderID, isCustomAmount: this.isCustomAmount }
                );
                
                // 포인트 반영 성공 시 상태 업데이트
                await firebaseService.updateDocument(
                    'payments',
                    `payment_${orderID}`,
                    { 
                        pointStatus: 'completed',
                        processingStage: 'completed',
                        updatedAt: Timestamp ? Timestamp.now() : new Date()
                    }
                );
                
                log.info('[Payment] Points added to wallet successfully', {
                    orderID: details.id,
                    points: points
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
                    isCustomAmount: this.isCustomAmount
                });
                
                eventBus.emit(EVENTS.UI_NOTIFICATION, {
                    type: 'success',
                    message: `${points.toLocaleString()} points added! 🎉`
                });
                
                log.info(`[Payment] Payment success: ${points} points ($${amount})`);
                
            } catch (walletError) {
                log.error('[Payment] Failed to add points to wallet:', walletError);
                
                // 포인트 반영 실패 시 상태 업데이트
                try {
                    await firebaseService.updateDocument(
                        'payments',
                        `payment_${orderID}`,
                        { 
                            pointStatus: 'failed',
                            processingStage: 'points_failed',
                            pointError: walletError.message,
                            updatedAt: Timestamp ? Timestamp.now() : new Date()
                        }
                    );
                    
                    // 에러 로그도 저장
                    await this.logPaymentErrorToFirestore(orderID, {
                        stage: 'adding_points',
                        error: walletError.message || String(walletError),
                        errorName: walletError.name,
                        stack: CONFIG.DEBUG.PAYMENT ? walletError.stack : undefined
                    });
                } catch (updateError) {
                    log.error('[Payment] Failed to update payment record:', updateError);
                }
                
                // 결제는 성공했지만 포인트 반영 실패 - 중간 상태 메시지
                throw new Error(`결제는 완료되었지만 포인트 반영에 실패했습니다. 주문번호: ${orderID}. 관리자에게 문의해주세요.`);
            }
        } else {
            // 검증 실패: 결제는 됐을 수도 있지만 확인 필요
            const validationIssues = [];
            if (!isPaymentSuccessful) validationIssues.push(`PayPal 상태: ${details.status}`);
            if (!amountMatches) validationIssues.push(`금액 불일치: 예상 ${amount}, 실제 ${capturedAmount}`);
            if (!isNotFailed) validationIssues.push(`결제 실패 상태: ${details.status}`);
            
            log.warn('[Payment] Payment validation failed', {
                orderID: details.id,
                issues: validationIssues,
                details: paymentRecord.validation
            });
            
            // 포인트 반영 상태를 'pending'으로 유지 (관리자 확인 필요)
            await firebaseService.updateDocument(
                'payments',
                `payment_${orderID}`,
                { 
                    pointStatus: 'pending',
                    processingStage: 'validation_failed',
                    validationIssues: validationIssues,
                    updatedAt: Timestamp ? Timestamp.now() : new Date()
                }
            );
            
            // 검증 실패 로그 저장
            await this.logPaymentErrorToFirestore(orderID, {
                stage: 'validation',
                error: 'Payment validation failed',
                validationIssues: validationIssues,
                details: paymentRecord.validation
            });
            
            // 사용자에게 중간 상태 메시지 표시
            throw new Error(`결제가 완료되었지만 확인이 필요합니다. 주문번호: ${details.id}. 관리자 확인 후 포인트가 반영됩니다.`);
        }
        
        // 커스텀 금액 초기화
        this.isCustomAmount = false;
        this.customAmount = null;
        this.selectedPackage = null;
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
        
        const isAdmin = this.isAdminMode();
        
        this.showScreen('processing-screen');
        document.getElementById('processing-message').textContent = 
            isAdmin ? 'Processing (Admin Mode - Free)...' : 'Processing your purchase...';
        
        try {
            // 관리자 모드가 아닌 경우에만 포인트 차감
            if (!isAdmin) {
                await walletService.deductPoints(
                    this.currentPayment.amount,
                    `Territory purchase: ${this.currentPayment.territoryName || this.currentPayment.territoryId}`,
                    TRANSACTION_TYPE.PURCHASE,
                    { territoryId: this.currentPayment.territoryId }
                );
            }
            
            // 구매 성공 이벤트 발행 (영토 정복 처리)
            eventBus.emit(EVENTS.PAYMENT_SUCCESS, {
                type: PRODUCT_TYPE.TERRITORY,
                territoryId: this.currentPayment.territoryId,
                amount: isAdmin ? 0 : this.currentPayment.amount,
                isAdmin: isAdmin
            });
            
            // 성공 화면
            this.showScreen('success-screen');
            document.getElementById('success-message').textContent = 
                isAdmin 
                    ? `🔧 Admin: ${this.currentPayment.territoryName || 'Territory'} claimed for FREE!`
                    : `You now own ${this.currentPayment.territoryName || 'this territory'}! 🎉`;
            
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'success',
                message: isAdmin 
                    ? `🔧 Admin claimed: ${this.currentPayment.territoryName || 'Territory'}`
                    : 'Territory claimed successfully! 🎉'
            });
            
        } catch (error) {
            log.error('Purchase failed:', error);
            
            if (error.message.includes('Insufficient')) {
                // 잔액 부족 - 충전 화면으로
                this.openChargeModal(this.currentPayment.amount);
                eventBus.emit(EVENTS.UI_NOTIFICATION, {
                    type: 'warning',
                    message: 'Insufficient balance. Please charge points first.'
                });
            } else {
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

