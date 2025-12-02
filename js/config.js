/**
 * Billionaire Homepage v2 - Configuration
 * 전역 설정 및 상수 정의
 */

export const CONFIG = {
    // 앱 정보
    APP_NAME: "Mr.Young's Billionaire Homepage",
    VERSION: '2.0.0',
    
    // Mapbox 설정
    MAPBOX: {
        ACCESS_TOKEN: 'pk.eyJ1IjoieW91bmc5MSIsImEiOiJjbWlvN2o1bjYwaGEzM2xvank4cjhrMGNzIn0.dIefOUuYqwYtl8MwXbpJuw',
        STYLE: 'mapbox://styles/mapbox/dark-v11',
        DEFAULT_CENTER: [0, 20],
        DEFAULT_ZOOM: 2,
        MAX_ZOOM: 12,
        MIN_ZOOM: 1
    },
    
    // Firebase 설정
    FIREBASE: {
        apiKey: "AIzaSyAa0BTlcqX9T1PYaHTiv3CmjmZ6srmdZVY",
        authDomain: "worldad-8be07.firebaseapp.com",
        projectId: "worldad-8be07",
        storageBucket: "worldad-8be07.firebasestorage.app",
        messagingSenderId: "460480155784",
        appId: "1:460480155784:web:68e6cea86cf492b3b64f3d",
        measurementId: "G-L2WYZGZK90"
    },
    
    // PayPal 설정
    PAYPAL: {
        CLIENT_ID: 'AQirNO21I_osrvoS7tvhGdtpGiv9sQC8k0XCurV-xZJZNY5ZnMn_64uwppCgscPbIfX2m1Nn9Z-TTPVp',
        CURRENCY: 'USD'
    },
    
    // 영토 기본 설정
    TERRITORY: {
        DEFAULT_TRIBUTE: 1000,  // 기본 조공 금액 (USD)
        MIN_TRIBUTE: 100,
        MAX_TRIBUTE: 100000,
        PIXEL_GRID_SIZE: 100    // 픽셀 캔버스 크기
    },
    
    // 버프 설정
    BUFFS: {
        ADJACENT_BONUS: 0.05,       // 인접 영토당 5%
        COUNTRY_THRESHOLD: 3,       // 국가 보너스 시작 영토 수
        COUNTRY_BONUS: 0.10,        // 국가 보너스 10%
        CONTINENT_BONUS: 0.20,      // 대륙 보너스 20%
        SEASON_BONUS_MAX: 0.15      // 시즌 최대 보너스 15%
    },
    
    // 랭킹 설정
    RANKING: {
        TERRITORY_SCORE: 100,       // 영토당 기본 점수
        PIXEL_SCORE: 1,             // 픽셀당 점수
        COUNTRY_DOMINATION: 500,    // 국가 지배 보너스
        CONTINENT_DOMINATION: 1000  // 대륙 지배 보너스
    },
    
    // 색상 테마
    COLORS: {
        // 주권 상태별 색상
        SOVEREIGNTY: {
            UNCONQUERED: '#4ecdc4',   // 미정복 - 청록
            CONTESTED: '#feca57',     // 분쟁 중 - 노랑
            RULED: '#ff6b6b'          // 통치됨 - 빨강
        },
        // UI 색상
        UI: {
            PRIMARY: '#4ecdc4',
            SECONDARY: '#ff6b6b',
            ACCENT: '#feca57',
            BACKGROUND: '#0a0a1a',
            SURFACE: 'rgba(0, 0, 0, 0.9)',
            TEXT: '#ffffff',
            TEXT_SECONDARY: '#cccccc'
        },
        // 랭킹 색상
        RANK: {
            GOLD: '#ffd700',
            SILVER: '#c0c0c0',
            BRONZE: '#cd7f32'
        }
    },
    
    // G20 국가 설정
    G20_COUNTRIES: {
        'usa': { name: 'United States', nameKo: '미국', center: [-95, 35], zoom: 4, flag: '🇺🇸' },
        'china': { name: 'China', nameKo: '중국', center: [104, 35], zoom: 4, flag: '🇨🇳' },
        'japan': { name: 'Japan', nameKo: '일본', center: [139, 36], zoom: 6, flag: '🇯🇵' },
        'germany': { name: 'Germany', nameKo: '독일', center: [10, 51], zoom: 6, flag: '🇩🇪' },
        'india': { name: 'India', nameKo: '인도', center: [77, 20], zoom: 4, flag: '🇮🇳' },
        'uk': { name: 'United Kingdom', nameKo: '영국', center: [-3, 54], zoom: 6, flag: '🇬🇧' },
        'france': { name: 'France', nameKo: '프랑스', center: [2, 46], zoom: 6, flag: '🇫🇷' },
        'italy': { name: 'Italy', nameKo: '이탈리아', center: [12, 42], zoom: 6, flag: '🇮🇹' },
        'brazil': { name: 'Brazil', nameKo: '브라질', center: [-55, -15], zoom: 4, flag: '🇧🇷' },
        'canada': { name: 'Canada', nameKo: '캐나다', center: [-106, 56], zoom: 4, flag: '🇨🇦' },
        'russia': { name: 'Russia', nameKo: '러시아', center: [100, 60], zoom: 3, flag: '🇷🇺' },
        'australia': { name: 'Australia', nameKo: '호주', center: [133, -27], zoom: 4, flag: '🇦🇺' },
        'mexico': { name: 'Mexico', nameKo: '멕시코', center: [-102, 23], zoom: 5, flag: '🇲🇽' },
        'south-korea': { name: 'South Korea', nameKo: '대한민국', center: [127, 36], zoom: 6, flag: '🇰🇷' },
        'indonesia': { name: 'Indonesia', nameKo: '인도네시아', center: [113, -5], zoom: 5, flag: '🇮🇩' },
        'saudi-arabia': { name: 'Saudi Arabia', nameKo: '사우디아라비아', center: [45, 24], zoom: 5, flag: '🇸🇦' },
        'turkey': { name: 'Turkey', nameKo: '튀르키예', center: [35, 39], zoom: 5, flag: '🇹🇷' },
        'south-africa': { name: 'South Africa', nameKo: '남아프리카공화국', center: [22, -30], zoom: 5, flag: '🇿🇦' },
        'argentina': { name: 'Argentina', nameKo: '아르헨티나', center: [-63, -38], zoom: 4, flag: '🇦🇷' },
        'european-union': { name: 'European Union', nameKo: '유럽연합', center: [10, 50], zoom: 4, flag: '🇪🇺' }
    },
    
    // v2 용어 (국제화)
    VOCABULARY: {
        ko: {
            territory: '영토',
            sovereignty: '주권',
            unconquered: '미정복',
            contested: '분쟁 중',
            ruled: '통치됨',
            conquest: '정복',
            tribute: '조공',
            ruler: '통치자',
            hegemony: '패권',
            pixel: '픽셀',
            value: '가치',
            rank: '랭킹',
            buff: '버프',
            history: '역사',
            collaborate: '협업',
            fandom: '팬덤'
        },
        en: {
            territory: 'Territory',
            sovereignty: 'Sovereignty',
            unconquered: 'Unconquered',
            contested: 'Contested',
            ruled: 'Ruled',
            conquest: 'Conquest',
            tribute: 'Tribute',
            ruler: 'Ruler',
            hegemony: 'Hegemony',
            pixel: 'Pixel',
            value: 'Value',
            rank: 'Rank',
            buff: 'Buff',
            history: 'History',
            collaborate: 'Collaborate',
            fandom: 'Fandom'
        }
    }
};

// 개발 모드 여부
export const IS_DEV = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// 로깅 헬퍼
export const log = {
    info: (...args) => IS_DEV && console.log('[v2]', ...args),
    warn: (...args) => console.warn('[v2]', ...args),
    error: (...args) => console.error('[v2]', ...args),
    debug: (...args) => IS_DEV && console.debug('[v2]', ...args)
};

export default CONFIG;

