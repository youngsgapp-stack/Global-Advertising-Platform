/**
 * I18nService - 국제화 서비스
 * 다국어 지원 및 언어 전환
 */

import { CONFIG, log } from '../config.js';

// 번역 데이터
const TRANSLATIONS = {
    en: {
        // 공통
        'app.name': 'Own a Piece of Earth',
        'app.tagline': 'Own a Piece of Earth',
        
        // 메뉴
        'menu.account': 'Account',
        'menu.signIn': 'Sign In',
        'menu.signOut': 'Sign Out',
        'menu.browse': 'Browse Territories',
        'menu.available': 'Available',
        'menu.auction': 'In Auction',
        'menu.owned': 'Owned',
        'menu.rankings': 'Rankings',
        'menu.topOwners': 'Top Owners',
        'menu.myTerritories': 'My Spots',
        'menu.help': 'Help',
        'menu.tutorial': 'Tutorial',
        'menu.howToPlay': 'How to Play',
        'menu.about': 'About',
        
        // 영토 패널
        'territory.available': 'Available',
        'territory.inAuction': 'In Auction',
        'territory.owned': 'Owned',
        'territory.owner': 'Owner',
        'territory.price': 'Price',
        'territory.country': 'Country',
        'territory.population': 'Population',
        'territory.area': 'Area',
        'territory.claimNow': '영토 구매',
        'territory.startAuction': 'Start Auction',
        'territory.placeBid': 'Place Bid',
        'territory.editPixels': 'Edit Pixels',
        
        // 결제
        'payment.charge': 'Charge Points',
        'payment.selectPackage': 'Select Package',
        'payment.customAmount': 'Custom Amount',
        'payment.pay': 'Pay',
        'payment.processing': 'Processing...',
        
        // 알림
        'notification.auctionWon': 'Auction Won!',
        'notification.territoryConquered': 'Territory Conquered',
        'notification.paymentComplete': 'Payment Complete',
        
        // 오류
        'error.generic': 'An error occurred',
        'error.network': 'Network error. Please check your connection.',
        'error.auth': 'Authentication failed',
        'error.payment': 'Payment failed',
        
        // 성공
        'success.saved': 'Saved',
        'success.purchased': 'Purchase successful',
        'success.bidPlaced': 'Bid placed successfully'
    },
    
    ko: {
        // 공통
        'app.name': '지구 한 조각 소유하기',
        'app.tagline': '지구의 한 조각을 소유하세요',
        
        // 메뉴
        'menu.account': '계정',
        'menu.signIn': '로그인',
        'menu.signOut': '로그아웃',
        'menu.browse': '영토 둘러보기',
        'menu.available': '구매 가능',
        'menu.auction': '경매 중',
        'menu.owned': '소유 중',
        'menu.rankings': '랭킹',
        'menu.topOwners': '상위 소유자',
        'menu.myTerritories': '내 영토',
        'menu.help': '도움말',
        'menu.tutorial': '튜토리얼',
        'menu.howToPlay': '게임 방법',
        'menu.about': '소개',
        
        // 영토 패널
        'territory.available': '구매 가능',
        'territory.inAuction': '경매 중',
        'territory.owned': '소유 중',
        'territory.owner': '소유자',
        'territory.price': '가격',
        'territory.country': '국가',
        'territory.population': '인구',
        'territory.area': '면적',
        'territory.claimNow': '이 영토 구매하기',
        'territory.startAuction': '경매 시작',
        'territory.placeBid': '입찰하기',
        'territory.editPixels': '픽셀 편집',
        
        // 결제
        'payment.charge': '포인트 충전',
        'payment.selectPackage': '패키지 선택',
        'payment.customAmount': '직접 입력',
        'payment.pay': '결제하기',
        'payment.processing': '처리 중...',
        
        // 알림
        'notification.auctionWon': '경매에서 승리했습니다!',
        'notification.territoryConquered': '영토를 획득했습니다',
        'notification.paymentComplete': '결제가 완료되었습니다',
        
        // 오류
        'error.generic': '오류가 발생했습니다',
        'error.network': '네트워크 오류. 연결을 확인해주세요.',
        'error.auth': '인증에 실패했습니다',
        'error.payment': '결제에 실패했습니다',
        
        // 성공
        'success.saved': '저장됨',
        'success.purchased': '구매 성공',
        'success.bidPlaced': '입찰 성공'
    }
};

class I18nService {
    constructor() {
        this.currentLanguage = this.detectLanguage();
        this.translations = TRANSLATIONS[this.currentLanguage] || TRANSLATIONS.en;
    }
    
    /**
     * 브라우저 언어 감지
     */
    detectLanguage() {
        // localStorage에서 언어 설정 확인
        const saved = localStorage.getItem('app_language');
        if (saved && TRANSLATIONS[saved]) {
            return saved;
        }
        
        // 브라우저 언어 확인
        const browserLang = navigator.language || navigator.userLanguage;
        const langCode = browserLang.split('-')[0].toLowerCase();
        
        if (TRANSLATIONS[langCode]) {
            return langCode;
        }
        
        // 기본값: 영어
        return 'en';
    }
    
    /**
     * 언어 설정
     */
    setLanguage(langCode) {
        if (!TRANSLATIONS[langCode]) {
            log.warn(`[I18n] Language not supported: ${langCode}`);
            return;
        }
        
        this.currentLanguage = langCode;
        this.translations = TRANSLATIONS[langCode];
        localStorage.setItem('app_language', langCode);
        
        // HTML lang 속성 업데이트
        document.documentElement.lang = langCode;
        
        // 이벤트 발생 (UI 업데이트용)
        window.dispatchEvent(new CustomEvent('languageChanged', {
            detail: { language: langCode }
        }));
        
        log.info(`[I18n] Language changed to: ${langCode}`);
    }
    
    /**
     * 번역 가져오기
     */
    t(key, params = {}) {
        let translation = this.translations[key];
        
        if (!translation) {
            // 영어로 폴백
            translation = TRANSLATIONS.en[key] || key;
            log.warn(`[I18n] Translation missing for key: ${key}`);
        }
        
        // 파라미터 치환
        if (params && Object.keys(params).length > 0) {
            Object.keys(params).forEach(param => {
                translation = translation.replace(`{{${param}}}`, params[param]);
            });
        }
        
        return translation;
    }
    
    /**
     * 현재 언어 가져오기
     */
    getCurrentLanguage() {
        return this.currentLanguage;
    }
    
    /**
     * 지원하는 언어 목록
     */
    getAvailableLanguages() {
        return Object.keys(TRANSLATIONS).map(code => ({
            code,
            name: this.getLanguageName(code)
        }));
    }
    
    /**
     * 언어 이름 가져오기
     */
    getLanguageName(code) {
        const names = {
            en: 'English',
            ko: '한국어'
        };
        return names[code] || code;
    }
    
    /**
     * 초기화
     */
    initialize() {
        // HTML lang 속성 설정
        document.documentElement.lang = this.currentLanguage;
        log.info(`[I18n] Initialized with language: ${this.currentLanguage}`);
    }
}

export const i18nService = new I18nService();
export default i18nService;

