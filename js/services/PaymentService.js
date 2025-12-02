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

class PaymentService {
    constructor() {
        this.initialized = false;
        this.paypalLoaded = false;
        this.currentPayment = null;
        this.modalContainer = null;
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
            // PayPal SDK 로드 확인
            this.checkPayPalLoaded();
            
            // 결제 모달 생성
            this.createPaymentModal();
            
            // 이벤트 리스너 설정
            this.setupEventListeners();
            
            this.initialized = true;
            log.info('PaymentService initialized');
            return true;
            
        } catch (error) {
            log.error('PaymentService initialization failed:', error);
            return false;
        }
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
            const checkInterval = setInterval(() => {
                if (typeof paypal !== 'undefined') {
                    this.paypalLoaded = true;
                    log.info('PayPal SDK loaded (delayed)');
                    clearInterval(checkInterval);
                }
            }, 500);
            
            // 10초 후 타임아웃
            setTimeout(() => {
                clearInterval(checkInterval);
                if (!this.paypalLoaded) {
                    log.warn('PayPal SDK load timeout');
                }
            }, 10000);
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
        
        // 잔액 확인
        if (walletService.hasBalance(amount)) {
            // 포인트로 바로 구매
            this.openConfirmModal(data);
        } else {
            // 잔액 부족 - 충전 모달 열기
            const shortage = amount - walletService.getBalance();
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: `Insufficient balance. You need $${shortage} more.`
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
                        <strong id="modal-current-balance">$0</strong>
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
                            <strong id="confirm-price">$0</strong>
                        </div>
                        <div class="purchase-item">
                            <span>Your Balance:</span>
                            <strong id="confirm-balance">$0</strong>
                        </div>
                        <div class="purchase-item total">
                            <span>After Purchase:</span>
                            <strong id="confirm-remaining">$0</strong>
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
                this.renderPayPalButton();
            });
        });
        
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
    openChargeModal(requiredAmount = 0) {
        this.showScreen('charge-screen');
        this.updateBalanceDisplay();
        this.selectedPackage = null;
        
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
        document.getElementById('confirm-price').textContent = `$${purchaseData.amount}`;
        document.getElementById('confirm-balance').textContent = `$${balance}`;
        document.getElementById('confirm-remaining').textContent = `$${remaining}`;
        
        this.showScreen('confirm-screen');
        this.modalContainer.classList.remove('hidden');
    }
    
    /**
     * 화면 전환
     */
    showScreen(screenId) {
        document.querySelectorAll('.payment-screen').forEach(screen => {
            screen.classList.add('hidden');
        });
        document.getElementById(screenId)?.classList.remove('hidden');
    }
    
    /**
     * 모달 닫기
     */
    closeModal() {
        this.modalContainer.classList.add('hidden');
        this.currentPayment = null;
        this.selectedPackage = null;
    }
    
    /**
     * 잔액 표시 업데이트
     */
    updateBalanceDisplay() {
        const balance = walletService.getBalance();
        document.getElementById('modal-current-balance').textContent = `$${balance}`;
    }
    
    /**
     * PayPal 버튼 렌더링
     */
    renderPayPalButton() {
        if (!this.paypalLoaded || !this.selectedPackage) {
            return;
        }
        
        const container = document.getElementById('paypal-button-container');
        container.innerHTML = ''; // 기존 버튼 제거
        
        paypal.Buttons({
            style: {
                layout: 'vertical',
                color: 'gold',
                shape: 'rect',
                label: 'pay'
            },
            
            createOrder: (data, actions) => {
                return actions.order.create({
                    purchase_units: [{
                        description: `Billionaire Map - ${this.selectedPackage.points} Points`,
                        amount: {
                            value: this.selectedPackage.amount.toString(),
                            currency_code: 'USD'
                        }
                    }]
                });
            },
            
            onApprove: async (data, actions) => {
                this.showScreen('processing-screen');
                document.getElementById('processing-message').textContent = 
                    'Completing your payment...';
                
                try {
                    // PayPal 결제 캡처
                    const details = await actions.order.capture();
                    
                    // 결제 성공 - 포인트 충전
                    await this.handlePayPalSuccess(details);
                    
                } catch (error) {
                    this.handlePaymentError(error);
                }
            },
            
            onCancel: () => {
                eventBus.emit(EVENTS.UI_NOTIFICATION, {
                    type: 'info',
                    message: 'Payment cancelled'
                });
                this.showScreen('charge-screen');
            },
            
            onError: (err) => {
                this.handlePaymentError(err);
            }
        }).render('#paypal-button-container');
    }
    
    /**
     * PayPal 결제 성공 처리
     */
    async handlePayPalSuccess(details) {
        try {
            const user = firebaseService.getCurrentUser();
            if (!user) {
                throw new Error('User not authenticated');
            }
            
            // 결제 기록 저장
            const paymentRecord = {
                paypalOrderId: details.id,
                paypalPayerId: details.payer?.payer_id,
                amount: this.selectedPackage.amount,
                points: this.selectedPackage.points,
                status: PAYMENT_STATUS.COMPLETED,
                userId: user.uid,
                createdAt: new Date()
            };
            
            await firebaseService.setDocument(
                'payments',
                `payment_${details.id}`,
                paymentRecord
            );
            
            // 포인트 충전
            await walletService.addPoints(
                this.selectedPackage.points,
                `PayPal charge: $${this.selectedPackage.amount}`,
                TRANSACTION_TYPE.CHARGE,
                { paypalOrderId: details.id }
            );
            
            // 성공 화면 표시
            this.showScreen('success-screen');
            document.getElementById('success-message').textContent = 
                `${this.selectedPackage.points} points have been added to your wallet!`;
            
            // 성공 이벤트 발행
            eventBus.emit(EVENTS.PAYMENT_SUCCESS, {
                type: PRODUCT_TYPE.POINTS,
                amount: this.selectedPackage.amount,
                points: this.selectedPackage.points
            });
            
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'success',
                message: `${this.selectedPackage.points} points added! 🎉`
            });
            
            log.info(`Payment success: ${this.selectedPackage.points} points`);
            
        } catch (error) {
            log.error('Failed to process payment:', error);
            this.handlePaymentError(error);
        }
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
        document.getElementById('processing-message').textContent = 
            'Processing your purchase...';
        
        try {
            // 포인트 차감
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
                amount: this.currentPayment.amount
            });
            
            // 성공 화면
            this.showScreen('success-screen');
            document.getElementById('success-message').textContent = 
                `You now own ${this.currentPayment.territoryName || 'this territory'}! 🎉`;
            
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'success',
                message: 'Territory claimed successfully! 🎉'
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
     * 결제 오류 처리
     */
    handlePaymentError(error) {
        log.error('Payment error:', error);
        
        this.showScreen('charge-screen');
        
        eventBus.emit(EVENTS.PAYMENT_ERROR, { error });
        eventBus.emit(EVENTS.UI_NOTIFICATION, {
            type: 'error',
            message: 'Payment failed. Please try again.'
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
        if (this.modalContainer) {
            this.modalContainer.remove();
        }
        this.initialized = false;
    }
}

// 싱글톤 인스턴스
export const paymentService = new PaymentService();
export default paymentService;

