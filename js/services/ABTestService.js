/**
 * ABTestService - A/B 테스팅 서비스
 * 사용자 그룹 분리 및 변형 관리
 */

import { CONFIG, log } from '../config.js';
import { analyticsService } from './AnalyticsService.js';

class ABTestService {
    constructor() {
        this.variants = new Map();
        this.userGroup = this.getUserGroup();
    }
    
    /**
     * 사용자 그룹 할당 (영구적)
     */
    getUserGroup() {
        const stored = localStorage.getItem('ab_test_group');
        if (stored) {
            return stored;
        }
        
        // 랜덤 그룹 할당 (A 또는 B)
        const group = Math.random() < 0.5 ? 'A' : 'B';
        localStorage.setItem('ab_test_group', group);
        log.info(`[ABTest] User assigned to group: ${group}`);
        return group;
    }
    
    /**
     * 테스트 등록
     */
    registerTest(testName, variants) {
        this.variants.set(testName, variants);
        log.info(`[ABTest] Test registered: ${testName}`);
    }
    
    /**
     * 변형 가져오기
     */
    getVariant(testName) {
        const variants = this.variants.get(testName);
        if (!variants) {
            log.warn(`[ABTest] Test not found: ${testName}`);
            return null;
        }
        
        // 그룹에 따라 변형 선택
        const variant = this.userGroup === 'A' ? variants.variantA : variants.variantB;
        
        // Analytics 추적
        analyticsService?.trackEvent('ab_test_view', {
            test_name: testName,
            variant: this.userGroup,
            variant_name: variant.name
        });
        
        return variant;
    }
    
    /**
     * 테스트 이벤트 추적
     */
    trackConversion(testName, conversionName, data = {}) {
        analyticsService?.trackEvent('ab_test_conversion', {
            test_name: testName,
            variant: this.userGroup,
            conversion_name: conversionName,
            ...data
        });
        
        log.info(`[ABTest] Conversion tracked: ${testName} - ${conversionName}`);
    }
    
    /**
     * 결제 버튼 위치 테스트
     */
    initializePaymentButtonTest() {
        this.registerTest('payment_button_position', {
            variantA: {
                name: 'top',
                position: 'top',
                style: 'primary'
            },
            variantB: {
                name: 'bottom',
                position: 'bottom',
                style: 'floating'
            }
        });
    }
    
    /**
     * 온보딩 플로우 테스트
     */
    initializeOnboardingTest() {
        this.registerTest('onboarding_flow', {
            variantA: {
                name: 'short',
                steps: 3,
                showTutorial: false
            },
            variantB: {
                name: 'detailed',
                steps: 5,
                showTutorial: true
            }
        });
    }
}

export const abTestService = new ABTestService();
export default abTestService;

