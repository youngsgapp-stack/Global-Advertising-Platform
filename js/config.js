/**
 * Billionaire Homepage v2 - Configuration
 * 전역 설정 및 상수 정의
 */

export const CONFIG = {
    // 앱 정보
    APP_NAME: "Own a Piece of Earth",
    APP_TAGLINE: "Create & Share Your Pixel Art on World Map", // 포지셔닝: "투자" → "창작/표현"
    VERSION: '2.0.0',
    
    // Mapbox 설정
    MAPBOX: {
        ACCESS_TOKEN: 'pk.eyJ1IjoieW91bmc5MSIsImEiOiJjbWlvN2o1bjYwaGEzM2xvank4cjhrMGNzIn0.dIefOUuYqwYtl8MwXbpJuw',
        // standard: 바다(밝은 파란색), 대지(자연색), 도로/지명 표시 - 균형 잡힌 스타일
        STYLE: 'mapbox://styles/mapbox/standard',
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
    
    // Google Analytics 설정
    ANALYTICS: {
        ENABLED: true,
        MEASUREMENT_ID: 'G-L2WYZGZK90', // Firebase Measurement ID 사용
        // 커스텀 이벤트 추적 활성화
        TRACK_EVENTS: true,
        TRACK_PAGE_VIEWS: true,
        TRACK_USER_ACTIONS: true
    },
    
    // PayPal 설정 (Sandbox - World Map Advertising 앱)
    // ⚠️ 테스트용 Sandbox 모드 - 프로덕션 배포 전에 Live Client ID로 변경 필요
    PAYPAL: {
        CLIENT_ID: 'ASSXMliYJQwdhXBONsRFuvA2ZsOQSfcG0v-ed3WgmG_KG8kQYyivPSOBsEy3KkDVXr2FS1uooo7urAIn', // Sandbox Client ID
        CURRENCY: 'USD',
        INTENT: 'capture' // 즉시 결제 캡처 모드
    },
    
    // Payoneer Checkout 설정
    // ⚠️ Payoneer 계정 생성 후 API Key와 Merchant ID를 설정해야 합니다
    PAYONEER: {
        MERCHANT_ID: '', // Payoneer Merchant ID (계정 생성 후 설정 필요)
        API_KEY: '', // Payoneer API Key (계정 생성 후 설정 필요)
        ENVIRONMENT: 'sandbox', // 'sandbox' | 'production'
        CURRENCY: 'USD',
        CHECKOUT_URL: 'https://checkout.payoneer.com', // Payoneer Checkout URL
        // RETURN_URL과 CANCEL_URL은 PaymentService에서 동적으로 설정됩니다
    },
    
    // 디버그 모드 설정
    DEBUG: {
        PAYMENT: true, // 결제 관련 상세 로그 및 디버그 메시지 표시
        PAYMENT_VERBOSE: true, // 결제 단계별 상세 로깅
        PERFORMANCE: false // 성능 최적화 로그 (기본값: false, 개발 시 true로 설정)
    },
    
    // 영토 기본 설정
    TERRITORY: {
        DEFAULT_TRIBUTE: 1000,  // 기본 조공 금액 (USD)
        MIN_TRIBUTE: 100,
        MAX_TRIBUTE: 100000,
        PIXEL_GRID_SIZE: 128,    // 픽셀 캔버스 크기 (고정 해상도: 128×128)
        PIXEL_GRID_SIZE_LEGACY: 64, // 레거시 64×64 지원
        GRID_VERSION: 2,         // 그리드 버전 (1 = 64×64, 2 = 128×128)
        TILE_SIZE: 16,           // 타일 크기 (128 / 16 = 8×8 타일)
        
        // ⚠️ 이미지 스탬프 정책 (프리뷰/적용 분리 구조)
        IMAGE_STAMP: {
            // 월드 셀 크기 정책 (명시적)
            WORLD_CELL_SIZE: 128, // 월드 그리드 크기 (셀 단위)
            
            // 기본 스탬프 크기 정책 (월드 셀 기준)
            DEFAULT_STAMP_SIZE_CELLS: {
                width: 32,  // 기본 가로 32셀
                height: 32  // 기본 세로 32셀 (비율 유지 시 자동 계산)
            },
            
            // 프리뷰 캐시 크기 (표시용, 품질과 무관)
            PREVIEW_CACHE_SIZE: 64, // 프리뷰용 작은 캐시 (빠른 피드백)
            
            // 최종 샘플링 방식 정책
            SAMPLING: {
                // 픽셀아트 느낌: nearest (또렷)
                PIXEL_ART: {
                    smoothing: false,
                    quality: 'nearest'
                },
                // 사진/로고: high quality (부드럽지만 선명)
                PHOTO_LOGO: {
                    smoothing: true,
                    quality: 'high'
                }
            }
        },
        
        // ⚠️ 운영 안정성: 타일 시스템 가드레일
        TILE_SYSTEM: {
            // 타일 수 상한 (16×16 기준: 8×8 = 64개)
            MAX_TILES_PER_TERRITORY: 64, // tilesX * tilesY = 8 * 8
            // 타일 payload 크기 상한 (KB)
            MAX_TILE_PAYLOAD_SIZE_KB: 50, // 타일당 최대 50KB
            // 저장 요청당 최대 타일 수
            MAX_TILES_PER_SAVE: 100,
            // 저장 chunk 크기 (상한 초과 시 분할)
            SAVE_CHUNK_SIZE: 50,
            // 압축 payload 인코딩 버전
            PAYLOAD_ENCODING_VERSION: 1,
            // 빈 타일 표현 규칙
            EMPTY_TILE_MARKER: null, // null = 빈 타일
            // 단색 타일 최적화 임계값 (픽셀 수)
            SOLID_COLOR_THRESHOLD: 200 // 200픽셀 이상 단색이면 최적화
        },
        AUCTION_STARTING_BID_RATIO: 0.6  // 경매 시작가 = 즉시 구매가의 60% (0.5 = 50%, 0.7 = 70%)
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
            CONTESTED: '#ff6600',     // 분쟁 중 - 주황 (더 눈에 띄게)
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
    
    // API 설정
    // API_BASE_URL: 로컬 개발 시 localhost 사용, 프로덕션 배포 시 Railway URL 사용
    API_BASE_URL: typeof window !== 'undefined' && window.location.hostname === 'localhost' 
        ? 'http://localhost:3000/api' 
        : 'https://global-advertising-platform-production.up.railway.app/api', // Railway 백엔드 API URL
    
    // 전 세계 국가 설정 (200+ 국가)
    COUNTRIES: {
        // ═══════════════════════════════════════════════
        // 🌏 아시아 (ASIA)
        // ═══════════════════════════════════════════════
        'south-korea': { name: 'South Korea', nameKo: '대한민국', center: [127, 36], zoom: 6, flag: '🇰🇷', group: 'asia', continent: 'asia' },
        'japan': { name: 'Japan', nameKo: '일본', center: [139, 36], zoom: 6, flag: '🇯🇵', group: 'asia', continent: 'asia' },
        'china': { name: 'China', nameKo: '중국', center: [104, 35], zoom: 4, flag: '🇨🇳', group: 'asia', continent: 'asia' },
        'taiwan': { name: 'Taiwan', nameKo: '대만', center: [121, 24], zoom: 7, flag: '🇹🇼', group: 'asia', continent: 'asia' },
        'hong-kong': { name: 'Hong Kong', nameKo: '홍콩', center: [114, 22], zoom: 10, flag: '🇭🇰', group: 'asia', continent: 'asia' },
        'india': { name: 'India', nameKo: '인도', center: [77, 20], zoom: 4, flag: '🇮🇳', group: 'asia', continent: 'asia' },
        'indonesia': { name: 'Indonesia', nameKo: '인도네시아', center: [113, -5], zoom: 4, flag: '🇮🇩', group: 'asia', continent: 'asia' },
        'thailand': { name: 'Thailand', nameKo: '태국', center: [101, 15], zoom: 5, flag: '🇹🇭', group: 'asia', continent: 'asia' },
        'vietnam': { name: 'Vietnam', nameKo: '베트남', center: [106, 16], zoom: 5, flag: '🇻🇳', group: 'asia', continent: 'asia' },
        'malaysia': { name: 'Malaysia', nameKo: '말레이시아', center: [109, 4], zoom: 5, flag: '🇲🇾', group: 'asia', continent: 'asia' },
        'singapore': { name: 'Singapore', nameKo: '싱가포르', center: [104, 1], zoom: 11, flag: '🇸🇬', group: 'asia', continent: 'asia' },
        'philippines': { name: 'Philippines', nameKo: '필리핀', center: [122, 12], zoom: 5, flag: '🇵🇭', group: 'asia', continent: 'asia' },
        'pakistan': { name: 'Pakistan', nameKo: '파키스탄', center: [69, 30], zoom: 5, flag: '🇵🇰', group: 'asia', continent: 'asia' },
        'bangladesh': { name: 'Bangladesh', nameKo: '방글라데시', center: [90, 24], zoom: 6, flag: '🇧🇩', group: 'asia', continent: 'asia' },
        'myanmar': { name: 'Myanmar', nameKo: '미얀마', center: [96, 20], zoom: 5, flag: '🇲🇲', group: 'asia', continent: 'asia' },
        'cambodia': { name: 'Cambodia', nameKo: '캄보디아', center: [105, 12], zoom: 6, flag: '🇰🇭', group: 'asia', continent: 'asia' },
        'laos': { name: 'Laos', nameKo: '라오스', center: [103, 18], zoom: 6, flag: '🇱🇦', group: 'asia', continent: 'asia' },
        'mongolia': { name: 'Mongolia', nameKo: '몽골', center: [103, 46], zoom: 4, flag: '🇲🇳', group: 'asia', continent: 'asia' },
        'nepal': { name: 'Nepal', nameKo: '네팔', center: [84, 28], zoom: 6, flag: '🇳🇵', group: 'asia', continent: 'asia' },
        'sri-lanka': { name: 'Sri Lanka', nameKo: '스리랑카', center: [81, 8], zoom: 7, flag: '🇱🇰', group: 'asia', continent: 'asia' },
        'kazakhstan': { name: 'Kazakhstan', nameKo: '카자흐스탄', center: [67, 48], zoom: 4, flag: '🇰🇿', group: 'asia', continent: 'asia' },
        'uzbekistan': { name: 'Uzbekistan', nameKo: '우즈베키스탄', center: [64, 41], zoom: 5, flag: '🇺🇿', group: 'asia', continent: 'asia' },
        'north-korea': { name: 'North Korea', nameKo: '북한', center: [127, 40], zoom: 6, flag: '🇰🇵', group: 'asia', continent: 'asia' },
        'brunei': { name: 'Brunei', nameKo: '브루나이', center: [114, 4], zoom: 8, flag: '🇧🇳', group: 'asia', continent: 'asia' },
        'bhutan': { name: 'Bhutan', nameKo: '부탄', center: [90, 27], zoom: 7, flag: '🇧🇹', group: 'asia', continent: 'asia' },
        'maldives': { name: 'Maldives', nameKo: '몰디브', center: [73, 4], zoom: 7, flag: '🇲🇻', group: 'asia', continent: 'asia' },
        'timor-leste': { name: 'Timor-Leste', nameKo: '동티모르', center: [126, -9], zoom: 8, flag: '🇹🇱', group: 'asia', continent: 'asia' },

        // ═══════════════════════════════════════════════
        // 🏜️ 중동 (MIDDLE EAST)
        // ═══════════════════════════════════════════════
        'saudi-arabia': { name: 'Saudi Arabia', nameKo: '사우디아라비아', center: [45, 24], zoom: 5, flag: '🇸🇦', group: 'middle-east', continent: 'asia' },
        'uae': { name: 'United Arab Emirates', nameKo: '아랍에미리트', center: [54, 24], zoom: 6, flag: '🇦🇪', group: 'middle-east', continent: 'asia' },
        'qatar': { name: 'Qatar', nameKo: '카타르', center: [51, 25], zoom: 8, flag: '🇶🇦', group: 'middle-east', continent: 'asia' },
        'iran': { name: 'Iran', nameKo: '이란', center: [53, 32], zoom: 5, flag: '🇮🇷', group: 'middle-east', continent: 'asia' },
        'iraq': { name: 'Iraq', nameKo: '이라크', center: [44, 33], zoom: 5, flag: '🇮🇶', group: 'middle-east', continent: 'asia' },
        'israel': { name: 'Israel', nameKo: '이스라엘', center: [35, 31], zoom: 7, flag: '🇮🇱', group: 'middle-east', continent: 'asia' },
        'jordan': { name: 'Jordan', nameKo: '요르단', center: [37, 31], zoom: 7, flag: '🇯🇴', group: 'middle-east', continent: 'asia' },
        'lebanon': { name: 'Lebanon', nameKo: '레바논', center: [36, 34], zoom: 8, flag: '🇱🇧', group: 'middle-east', continent: 'asia' },
        'oman': { name: 'Oman', nameKo: '오만', center: [57, 21], zoom: 5, flag: '🇴🇲', group: 'middle-east', continent: 'asia' },
        'kuwait': { name: 'Kuwait', nameKo: '쿠웨이트', center: [48, 29], zoom: 8, flag: '🇰🇼', group: 'middle-east', continent: 'asia' },
        'bahrain': { name: 'Bahrain', nameKo: '바레인', center: [50, 26], zoom: 9, flag: '🇧🇭', group: 'middle-east', continent: 'asia' },
        'syria': { name: 'Syria', nameKo: '시리아', center: [38, 35], zoom: 6, flag: '🇸🇾', group: 'middle-east', continent: 'asia' },
        'yemen': { name: 'Yemen', nameKo: '예멘', center: [48, 15], zoom: 5, flag: '🇾🇪', group: 'middle-east', continent: 'asia' },
        'palestine': { name: 'Palestine', nameKo: '팔레스타인', center: [35, 32], zoom: 8, flag: '🇵🇸', group: 'middle-east', continent: 'asia' },
        'turkey': { name: 'Turkey', nameKo: '튀르키예', center: [35, 39], zoom: 5, flag: '🇹🇷', group: 'middle-east', continent: 'asia' },
        'afghanistan': { name: 'Afghanistan', nameKo: '아프가니스탄', center: [66, 34], zoom: 5, flag: '🇦🇫', group: 'middle-east', continent: 'asia' },

        // ═══════════════════════════════════════════════
        // 🇪🇺 유럽 (EUROPE)
        // ═══════════════════════════════════════════════
        'european-union': { name: 'European Union', nameKo: '유럽연합', center: [10, 50], zoom: 4, flag: '🇪🇺', group: 'europe', continent: 'europe' },
        'germany': { name: 'Germany', nameKo: '독일', center: [10, 51], zoom: 6, flag: '🇩🇪', group: 'europe', continent: 'europe' },
        'france': { name: 'France', nameKo: '프랑스', center: [2, 46], zoom: 5, flag: '🇫🇷', group: 'europe', continent: 'europe' },
        'uk': { name: 'United Kingdom', nameKo: '영국', center: [-3, 54], zoom: 5, flag: '🇬🇧', group: 'europe', continent: 'europe' },
        'italy': { name: 'Italy', nameKo: '이탈리아', center: [12, 42], zoom: 5, flag: '🇮🇹', group: 'europe', continent: 'europe' },
        'spain': { name: 'Spain', nameKo: '스페인', center: [-3, 40], zoom: 5, flag: '🇪🇸', group: 'europe', continent: 'europe' },
        'netherlands': { name: 'Netherlands', nameKo: '네덜란드', center: [5, 52], zoom: 7, flag: '🇳🇱', group: 'europe', continent: 'europe' },
        'poland': { name: 'Poland', nameKo: '폴란드', center: [19, 52], zoom: 5, flag: '🇵🇱', group: 'europe', continent: 'europe' },
        'belgium': { name: 'Belgium', nameKo: '벨기에', center: [4, 50], zoom: 7, flag: '🇧🇪', group: 'europe', continent: 'europe' },
        'sweden': { name: 'Sweden', nameKo: '스웨덴', center: [15, 62], zoom: 4, flag: '🇸🇪', group: 'europe', continent: 'europe' },
        'austria': { name: 'Austria', nameKo: '오스트리아', center: [14, 47], zoom: 6, flag: '🇦🇹', group: 'europe', continent: 'europe' },
        'switzerland': { name: 'Switzerland', nameKo: '스위스', center: [8, 47], zoom: 7, flag: '🇨🇭', group: 'europe', continent: 'europe' },
        'norway': { name: 'Norway', nameKo: '노르웨이', center: [10, 62], zoom: 4, flag: '🇳🇴', group: 'europe', continent: 'europe' },
        'portugal': { name: 'Portugal', nameKo: '포르투갈', center: [-8, 39], zoom: 6, flag: '🇵🇹', group: 'europe', continent: 'europe' },
        'greenland': { name: 'Greenland', nameKo: '그린란드', center: [-42, 72], zoom: 3, flag: '🇬🇱', group: 'north-america', continent: 'north-america' },
        'greece': { name: 'Greece', nameKo: '그리스', center: [22, 39], zoom: 6, flag: '🇬🇷', group: 'europe', continent: 'europe' },
        'czech-republic': { name: 'Czech Republic', nameKo: '체코', center: [15, 50], zoom: 6, flag: '🇨🇿', group: 'europe', continent: 'europe' },
        'romania': { name: 'Romania', nameKo: '루마니아', center: [25, 46], zoom: 6, flag: '🇷🇴', group: 'europe', continent: 'europe' },
        'hungary': { name: 'Hungary', nameKo: '헝가리', center: [19, 47], zoom: 6, flag: '🇭🇺', group: 'europe', continent: 'europe' },
        'denmark': { name: 'Denmark', nameKo: '덴마크', center: [10, 56], zoom: 6, flag: '🇩🇰', group: 'europe', continent: 'europe' },
        'finland': { name: 'Finland', nameKo: '핀란드', center: [26, 64], zoom: 4, flag: '🇫🇮', group: 'europe', continent: 'europe' },
        'ireland': { name: 'Ireland', nameKo: '아일랜드', center: [-8, 53], zoom: 6, flag: '🇮🇪', group: 'europe', continent: 'europe' },
        'bulgaria': { name: 'Bulgaria', nameKo: '불가리아', center: [25, 43], zoom: 6, flag: '🇧🇬', group: 'europe', continent: 'europe' },
        'slovakia': { name: 'Slovakia', nameKo: '슬로바키아', center: [19, 48], zoom: 7, flag: '🇸🇰', group: 'europe', continent: 'europe' },
        'croatia': { name: 'Croatia', nameKo: '크로아티아', center: [16, 45], zoom: 6, flag: '🇭🇷', group: 'europe', continent: 'europe' },
        'lithuania': { name: 'Lithuania', nameKo: '리투아니아', center: [24, 55], zoom: 6, flag: '🇱🇹', group: 'europe', continent: 'europe' },
        'slovenia': { name: 'Slovenia', nameKo: '슬로베니아', center: [15, 46], zoom: 7, flag: '🇸🇮', group: 'europe', continent: 'europe' },
        'latvia': { name: 'Latvia', nameKo: '라트비아', center: [25, 57], zoom: 6, flag: '🇱🇻', group: 'europe', continent: 'europe' },
        'estonia': { name: 'Estonia', nameKo: '에스토니아', center: [25, 59], zoom: 6, flag: '🇪🇪', group: 'europe', continent: 'europe' },
        'cyprus': { name: 'Cyprus', nameKo: '키프로스', center: [33, 35], zoom: 8, flag: '🇨🇾', group: 'europe', continent: 'europe' },
        'luxembourg': { name: 'Luxembourg', nameKo: '룩셈부르크', center: [6, 49], zoom: 9, flag: '🇱🇺', group: 'europe', continent: 'europe' },
        'malta': { name: 'Malta', nameKo: '몰타', center: [14, 36], zoom: 10, flag: '🇲🇹', group: 'europe', continent: 'europe' },
        'russia': { name: 'Russia', nameKo: '러시아', center: [100, 60], zoom: 3, flag: '🇷🇺', group: 'europe', continent: 'europe' },
        'ukraine': { name: 'Ukraine', nameKo: '우크라이나', center: [32, 49], zoom: 5, flag: '🇺🇦', group: 'europe', continent: 'europe' },
        'belarus': { name: 'Belarus', nameKo: '벨라루스', center: [28, 53], zoom: 5, flag: '🇧🇾', group: 'europe', continent: 'europe' },
        'serbia': { name: 'Serbia', nameKo: '세르비아', center: [21, 44], zoom: 6, flag: '🇷🇸', group: 'europe', continent: 'europe' },
        'albania': { name: 'Albania', nameKo: '알바니아', center: [20, 41], zoom: 7, flag: '🇦🇱', group: 'europe', continent: 'europe' },
        'north-macedonia': { name: 'North Macedonia', nameKo: '북마케도니아', center: [21, 41], zoom: 7, flag: '🇲🇰', group: 'europe', continent: 'europe' },
        'montenegro': { name: 'Montenegro', nameKo: '몬테네그로', center: [19, 43], zoom: 8, flag: '🇲🇪', group: 'europe', continent: 'europe' },
        'bosnia': { name: 'Bosnia & Herzegovina', nameKo: '보스니아', center: [18, 44], zoom: 7, flag: '🇧🇦', group: 'europe', continent: 'europe' },
        'moldova': { name: 'Moldova', nameKo: '몰도바', center: [29, 47], zoom: 6, flag: '🇲🇩', group: 'europe', continent: 'europe' },
        'iceland': { name: 'Iceland', nameKo: '아이슬란드', center: [-19, 65], zoom: 5, flag: '🇮🇸', group: 'europe', continent: 'europe' },
        'georgia': { name: 'Georgia', nameKo: '조지아', center: [43, 42], zoom: 6, flag: '🇬🇪', group: 'europe', continent: 'europe' },
        'armenia': { name: 'Armenia', nameKo: '아르메니아', center: [45, 40], zoom: 7, flag: '🇦🇲', group: 'europe', continent: 'europe' },
        'azerbaijan': { name: 'Azerbaijan', nameKo: '아제르바이잔', center: [48, 40], zoom: 6, flag: '🇦🇿', group: 'europe', continent: 'europe' },

        // ═══════════════════════════════════════════════
        // 🌎 북미 (NORTH AMERICA)
        // ═══════════════════════════════════════════════
        'usa': { name: 'United States', nameKo: '미국', center: [-95, 35], zoom: 4, flag: '🇺🇸', group: 'north-america', continent: 'north-america' },
        'canada': { name: 'Canada', nameKo: '캐나다', center: [-106, 56], zoom: 3, flag: '🇨🇦', group: 'north-america', continent: 'north-america' },
        'mexico': { name: 'Mexico', nameKo: '멕시코', center: [-102, 23], zoom: 5, flag: '🇲🇽', group: 'north-america', continent: 'north-america' },
        'cuba': { name: 'Cuba', nameKo: '쿠바', center: [-79, 22], zoom: 6, flag: '🇨🇺', group: 'north-america', continent: 'north-america' },
        'jamaica': { name: 'Jamaica', nameKo: '자메이카', center: [-77, 18], zoom: 8, flag: '🇯🇲', group: 'north-america', continent: 'north-america' },
        'haiti': { name: 'Haiti', nameKo: '아이티', center: [-72, 19], zoom: 8, flag: '🇭🇹', group: 'north-america', continent: 'north-america' },
        'dominican-republic': { name: 'Dominican Republic', nameKo: '도미니카공화국', center: [-70, 19], zoom: 7, flag: '🇩🇴', group: 'north-america', continent: 'north-america' },
        'guatemala': { name: 'Guatemala', nameKo: '과테말라', center: [-90, 15], zoom: 6, flag: '🇬🇹', group: 'north-america', continent: 'north-america' },
        'honduras': { name: 'Honduras', nameKo: '온두라스', center: [-87, 15], zoom: 6, flag: '🇭🇳', group: 'north-america', continent: 'north-america' },
        'el-salvador': { name: 'El Salvador', nameKo: '엘살바도르', center: [-89, 14], zoom: 8, flag: '🇸🇻', group: 'north-america', continent: 'north-america' },
        'nicaragua': { name: 'Nicaragua', nameKo: '니카라과', center: [-85, 13], zoom: 6, flag: '🇳🇮', group: 'north-america', continent: 'north-america' },
        'costa-rica': { name: 'Costa Rica', nameKo: '코스타리카', center: [-84, 10], zoom: 7, flag: '🇨🇷', group: 'north-america', continent: 'north-america' },
        'panama': { name: 'Panama', nameKo: '파나마', center: [-80, 9], zoom: 7, flag: '🇵🇦', group: 'north-america', continent: 'north-america' },
        'belize': { name: 'Belize', nameKo: '벨리즈', center: [-88, 17], zoom: 7, flag: '🇧🇿', group: 'north-america', continent: 'north-america' },
        'puerto-rico': { name: 'Puerto Rico', nameKo: '푸에르토리코', center: [-66, 18], zoom: 8, flag: '🇵🇷', group: 'north-america', continent: 'north-america' },

        // ═══════════════════════════════════════════════
        // 🌎 남미 (SOUTH AMERICA)
        // ═══════════════════════════════════════════════
        'brazil': { name: 'Brazil', nameKo: '브라질', center: [-55, -15], zoom: 4, flag: '🇧🇷', group: 'south-america', continent: 'south-america' },
        'argentina': { name: 'Argentina', nameKo: '아르헨티나', center: [-63, -38], zoom: 4, flag: '🇦🇷', group: 'south-america', continent: 'south-america' },
        'chile': { name: 'Chile', nameKo: '칠레', center: [-71, -35], zoom: 4, flag: '🇨🇱', group: 'south-america', continent: 'south-america' },
        'colombia': { name: 'Colombia', nameKo: '콜롬비아', center: [-74, 4], zoom: 5, flag: '🇨🇴', group: 'south-america', continent: 'south-america' },
        'peru': { name: 'Peru', nameKo: '페루', center: [-76, -10], zoom: 5, flag: '🇵🇪', group: 'south-america', continent: 'south-america' },
        'venezuela': { name: 'Venezuela', nameKo: '베네수엘라', center: [-66, 7], zoom: 5, flag: '🇻🇪', group: 'south-america', continent: 'south-america' },
        'ecuador': { name: 'Ecuador', nameKo: '에콰도르', center: [-78, -2], zoom: 6, flag: '🇪🇨', group: 'south-america', continent: 'south-america' },
        'bolivia': { name: 'Bolivia', nameKo: '볼리비아', center: [-64, -17], zoom: 5, flag: '🇧🇴', group: 'south-america', continent: 'south-america' },
        'paraguay': { name: 'Paraguay', nameKo: '파라과이', center: [-58, -23], zoom: 5, flag: '🇵🇾', group: 'south-america', continent: 'south-america' },
        'uruguay': { name: 'Uruguay', nameKo: '우루과이', center: [-56, -33], zoom: 6, flag: '🇺🇾', group: 'south-america', continent: 'south-america' },
        'guyana': { name: 'Guyana', nameKo: '가이아나', center: [-59, 5], zoom: 6, flag: '🇬🇾', group: 'south-america', continent: 'south-america' },
        'suriname': { name: 'Suriname', nameKo: '수리남', center: [-56, 4], zoom: 6, flag: '🇸🇷', group: 'south-america', continent: 'south-america' },

        // ═══════════════════════════════════════════════
        // 🌍 아프리카 (AFRICA)
        // ═══════════════════════════════════════════════
        'south-africa': { name: 'South Africa', nameKo: '남아프리카공화국', center: [22, -30], zoom: 5, flag: '🇿🇦', group: 'africa', continent: 'africa' },
        'egypt': { name: 'Egypt', nameKo: '이집트', center: [30, 27], zoom: 5, flag: '🇪🇬', group: 'africa', continent: 'africa' },
        'nigeria': { name: 'Nigeria', nameKo: '나이지리아', center: [8, 10], zoom: 5, flag: '🇳🇬', group: 'africa', continent: 'africa' },
        'kenya': { name: 'Kenya', nameKo: '케냐', center: [38, 0], zoom: 5, flag: '🇰🇪', group: 'africa', continent: 'africa' },
        'ethiopia': { name: 'Ethiopia', nameKo: '에티오피아', center: [38, 9], zoom: 5, flag: '🇪🇹', group: 'africa', continent: 'africa' },
        'ghana': { name: 'Ghana', nameKo: '가나', center: [-1, 8], zoom: 6, flag: '🇬🇭', group: 'africa', continent: 'africa' },
        'morocco': { name: 'Morocco', nameKo: '모로코', center: [-8, 32], zoom: 5, flag: '🇲🇦', group: 'africa', continent: 'africa' },
        'algeria': { name: 'Algeria', nameKo: '알제리', center: [3, 28], zoom: 4, flag: '🇩🇿', group: 'africa', continent: 'africa' },
        'tunisia': { name: 'Tunisia', nameKo: '튀니지', center: [9, 34], zoom: 6, flag: '🇹🇳', group: 'africa', continent: 'africa' },
        'libya': { name: 'Libya', nameKo: '리비아', center: [17, 27], zoom: 5, flag: '🇱🇾', group: 'africa', continent: 'africa' },
        'sudan': { name: 'Sudan', nameKo: '수단', center: [30, 15], zoom: 5, flag: '🇸🇩', group: 'africa', continent: 'africa' },
        'south-sudan': { name: 'South Sudan', nameKo: '남수단', center: [31, 7], zoom: 5, flag: '🇸🇸', group: 'africa', continent: 'africa' },
        'tanzania': { name: 'Tanzania', nameKo: '탄자니아', center: [35, -6], zoom: 5, flag: '🇹🇿', group: 'africa', continent: 'africa' },
        'uganda': { name: 'Uganda', nameKo: '우간다', center: [32, 1], zoom: 6, flag: '🇺🇬', group: 'africa', continent: 'africa' },
        'rwanda': { name: 'Rwanda', nameKo: '르완다', center: [30, -2], zoom: 8, flag: '🇷🇼', group: 'africa', continent: 'africa' },
        'senegal': { name: 'Senegal', nameKo: '세네갈', center: [-14, 14], zoom: 6, flag: '🇸🇳', group: 'africa', continent: 'africa' },
        'niger': { name: 'Niger', nameKo: '니제르', center: [9, 17], zoom: 5, flag: '🇳🇪', group: 'africa', continent: 'africa' },
        'mali': { name: 'Mali', nameKo: '말리', center: [-4, 17], zoom: 5, flag: '🇲🇱', group: 'africa', continent: 'africa' },
        'mauritania': { name: 'Mauritania', nameKo: '모리타니', center: [-12, 20], zoom: 5, flag: '🇲🇷', group: 'africa', continent: 'africa' },
        'ivory-coast': { name: 'Ivory Coast', nameKo: '코트디부아르', center: [-5, 8], zoom: 6, flag: '🇨🇮', group: 'africa', continent: 'africa' },
        'cameroon': { name: 'Cameroon', nameKo: '카메룬', center: [12, 6], zoom: 5, flag: '🇨🇲', group: 'africa', continent: 'africa' },
        'angola': { name: 'Angola', nameKo: '앙골라', center: [17, -12], zoom: 5, flag: '🇦🇴', group: 'africa', continent: 'africa' },
        'mozambique': { name: 'Mozambique', nameKo: '모잠비크', center: [35, -18], zoom: 5, flag: '🇲🇿', group: 'africa', continent: 'africa' },
        'zimbabwe': { name: 'Zimbabwe', nameKo: '짐바브웨', center: [29, -19], zoom: 5, flag: '🇿🇼', group: 'africa', continent: 'africa' },
        'zambia': { name: 'Zambia', nameKo: '잠비아', center: [28, -14], zoom: 5, flag: '🇿🇲', group: 'africa', continent: 'africa' },
        'botswana': { name: 'Botswana', nameKo: '보츠와나', center: [24, -22], zoom: 5, flag: '🇧🇼', group: 'africa', continent: 'africa' },
        'namibia': { name: 'Namibia', nameKo: '나미비아', center: [17, -22], zoom: 5, flag: '🇳🇦', group: 'africa', continent: 'africa' },
        'madagascar': { name: 'Madagascar', nameKo: '마다가스카르', center: [47, -19], zoom: 5, flag: '🇲🇬', group: 'africa', continent: 'africa' },
        'mauritius': { name: 'Mauritius', nameKo: '모리셔스', center: [57, -20], zoom: 8, flag: '🇲🇺', group: 'africa', continent: 'africa' },
        'congo-drc': { name: 'DR Congo', nameKo: '콩고민주공화국', center: [23, -4], zoom: 5, flag: '🇨🇩', group: 'africa', continent: 'africa' },
        'mali': { name: 'Mali', nameKo: '말리', center: [-4, 17], zoom: 5, flag: '🇲🇱', group: 'africa', continent: 'africa' },
        'central-african-republic': { name: 'Central African Republic', nameKo: '중앙아프리카공화국', center: [21, 7], zoom: 5, flag: '🇨🇫', group: 'africa', continent: 'africa' },
        'chad': { name: 'Chad', nameKo: '차드', center: [19, 15], zoom: 5, flag: '🇹🇩', group: 'africa', continent: 'africa' },
        'burkina-faso': { name: 'Burkina Faso', nameKo: '부르키나파소', center: [-2, 12], zoom: 5, flag: '🇧🇫', group: 'africa', continent: 'africa' },
        'benin': { name: 'Benin', nameKo: '베냉', center: [2, 9], zoom: 5, flag: '🇧🇯', group: 'africa', continent: 'africa' },
        'togo': { name: 'Togo', nameKo: '토고', center: [1, 8], zoom: 6, flag: '🇹🇬', group: 'africa', continent: 'africa' },
        'guinea': { name: 'Guinea', nameKo: '기니', center: [-10, 10], zoom: 5, flag: '🇬🇳', group: 'africa', continent: 'africa' },
        'guinea-bissau': { name: 'Guinea-Bissau', nameKo: '기니비사우', center: [-15, 12], zoom: 6, flag: '🇬🇼', group: 'africa', continent: 'africa' },
        'sierra-leone': { name: 'Sierra Leone', nameKo: '시에라리온', center: [-12, 8], zoom: 6, flag: '🇸🇱', group: 'africa', continent: 'africa' },
        'liberia': { name: 'Liberia', nameKo: '라이베리아', center: [-9, 6], zoom: 6, flag: '🇱🇷', group: 'africa', continent: 'africa' },
        'gambia': { name: 'Gambia', nameKo: '감비아', center: [-15, 13], zoom: 7, flag: '🇬🇲', group: 'africa', continent: 'africa' },
        'cape-verde': { name: 'Cape Verde', nameKo: '카보베르데', center: [-24, 16], zoom: 7, flag: '🇨🇻', group: 'africa', continent: 'africa' },
        'sao-tome-and-principe': { name: 'São Tomé and Príncipe', nameKo: '상투메 프린시페', center: [7, 1], zoom: 8, flag: '🇸🇹', group: 'africa', continent: 'africa' },
        'equatorial-guinea': { name: 'Equatorial Guinea', nameKo: '적도 기니', center: [10, 2], zoom: 6, flag: '🇬🇶', group: 'africa', continent: 'africa' },
        'gabon': { name: 'Gabon', nameKo: '가봉', center: [12, -1], zoom: 5, flag: '🇬🇦', group: 'africa', continent: 'africa' },
        'eritrea': { name: 'Eritrea', nameKo: '에리트레아', center: [39, 15], zoom: 6, flag: '🇪🇷', group: 'africa', continent: 'africa' },
        'djibouti': { name: 'Djibouti', nameKo: '지부티', center: [43, 12], zoom: 7, flag: '🇩🇯', group: 'africa', continent: 'africa' },
        'somalia': { name: 'Somalia', nameKo: '소말리아', center: [46, 6], zoom: 5, flag: '🇸🇴', group: 'africa', continent: 'africa' },
        'comoros': { name: 'Comoros', nameKo: '코모로', center: [44, -12], zoom: 8, flag: '🇰🇲', group: 'africa', continent: 'africa' },
        'seychelles': { name: 'Seychelles', nameKo: '세이셸', center: [55, -5], zoom: 8, flag: '🇸🇨', group: 'africa', continent: 'africa' },
        'eswatini': { name: 'Eswatini', nameKo: '에스와티니', center: [31, -26], zoom: 7, flag: '🇸🇿', group: 'africa', continent: 'africa' },
        'lesotho': { name: 'Lesotho', nameKo: '레소토', center: [28, -29], zoom: 7, flag: '🇱🇸', group: 'africa', continent: 'africa' },
        'malawi': { name: 'Malawi', nameKo: '말라위', center: [34, -13], zoom: 6, flag: '🇲🇼', group: 'africa', continent: 'africa' },
        'burundi': { name: 'Burundi', nameKo: '부룬디', center: [30, -3], zoom: 7, flag: '🇧🇮', group: 'africa', continent: 'africa' },
        'ivory-coast': { name: "Côte d'Ivoire", nameKo: '코트디부아르', center: [-5, 8], zoom: 6, flag: '🇨🇮', group: 'africa', continent: 'africa' },
        'cameroon': { name: 'Cameroon', nameKo: '카메룬', center: [12, 6], zoom: 5, flag: '🇨🇲', group: 'africa', continent: 'africa' },
        'angola': { name: 'Angola', nameKo: '앙골라', center: [17, -12], zoom: 5, flag: '🇦🇴', group: 'africa', continent: 'africa' },
        'mozambique': { name: 'Mozambique', nameKo: '모잠비크', center: [35, -18], zoom: 5, flag: '🇲🇿', group: 'africa', continent: 'africa' },
        'zimbabwe': { name: 'Zimbabwe', nameKo: '짐바브웨', center: [29, -19], zoom: 5, flag: '🇿🇼', group: 'africa', continent: 'africa' },
        'zambia': { name: 'Zambia', nameKo: '잠비아', center: [27, -14], zoom: 5, flag: '🇿🇲', group: 'africa', continent: 'africa' },
        'botswana': { name: 'Botswana', nameKo: '보츠와나', center: [24, -22], zoom: 5, flag: '🇧🇼', group: 'africa', continent: 'africa' },
        'namibia': { name: 'Namibia', nameKo: '나미비아', center: [18, -22], zoom: 5, flag: '🇳🇦', group: 'africa', continent: 'africa' },
        'madagascar': { name: 'Madagascar', nameKo: '마다가스카르', center: [47, -19], zoom: 5, flag: '🇲🇬', group: 'africa', continent: 'africa' },
        'mauritius': { name: 'Mauritius', nameKo: '모리셔스', center: [57, -20], zoom: 9, flag: '🇲🇺', group: 'africa', continent: 'africa' },
        'congo-drc': { name: 'DR Congo', nameKo: '콩고민주공화국', center: [23, -3], zoom: 4, flag: '🇨🇩', group: 'africa', continent: 'africa' },

        // ═══════════════════════════════════════════════
        // 🌏 오세아니아 (OCEANIA)
        // ═══════════════════════════════════════════════
        'australia': { name: 'Australia', nameKo: '호주', center: [133, -27], zoom: 4, flag: '🇦🇺', group: 'oceania', continent: 'oceania' },
        'new-zealand': { name: 'New Zealand', nameKo: '뉴질랜드', center: [174, -41], zoom: 5, flag: '🇳🇿', group: 'oceania', continent: 'oceania' },
        'fiji': { name: 'Fiji', nameKo: '피지', center: [178, -18], zoom: 7, flag: '🇫🇯', group: 'oceania', continent: 'oceania' },
        'papua-new-guinea': { name: 'Papua New Guinea', nameKo: '파푸아뉴기니', center: [145, -6], zoom: 5, flag: '🇵🇬', group: 'oceania', continent: 'oceania' }
    },
    
    // G20_COUNTRIES는 하위 호환성을 위해 유지
    get G20_COUNTRIES() { return this.COUNTRIES; },
    
    // v2 용어 (국제화) - 친근하고 가벼운 톤
    VOCABULARY: {
        ko: {
            territory: '스팟',
            spot: '스팟',
            sovereignty: '소유',
            unconquered: '비어있음',
            available: '비어있음',
            contested: '경쟁 중',
            bidding: '경쟁 중',
            ruled: '주인 있음',
            owned: '주인 있음',
            conquest: '차지하기',
            claim: '구매하기',
            tribute: '후원',
            support: '후원',
            ruler: '주인',
            owner: '주인',
            hegemony: '랭킹',
            ranking: '랭킹',
            pixel: '픽셀',
            value: '가치',
            rank: '순위',
            buff: '보너스',
            bonus: '보너스',
            history: '기록',
            log: '기록',
            collaborate: '함께 꾸미기',
            decorate: '꾸미기',
            fandom: '팬덤',
            mySpot: '내 스팟',
            getSpot: '스팟 구매하기',
            topOwners: '인기 주인',
            newSpots: '새로운 스팟'
        },
        en: {
            territory: 'Spot',
            spot: 'Spot',
            sovereignty: 'Ownership',
            unconquered: 'Available',
            available: 'Available',
            contested: 'Bidding',
            bidding: 'Bidding',
            ruled: 'Owned',
            owned: 'Owned',
            conquest: 'Own This Territory',
            claim: 'Claim',
            tribute: 'Support',
            support: 'Support',
            ruler: 'Owner',
            owner: 'Owner',
            hegemony: 'Ranking',
            ranking: 'Ranking',
            pixel: 'Pixel',
            value: 'Value',
            rank: 'Rank',
            buff: 'Bonus',
            bonus: 'Bonus',
            history: 'Log',
            log: 'Log',
            collaborate: 'Decorate Together',
            decorate: 'Decorate',
            fandom: 'Fans',
            mySpot: 'My Spot',
            getSpot: 'Own This Territory',
            topOwners: 'Top Owners',
            newSpots: 'New Spots'
        }
    }
};

// 개발 모드 여부 (로컬 네트워크 IP 포함)
const isLocalNetwork = /^192\.168\.|^10\.|^172\.(1[6-9]|2[0-9]|3[01])\.|^localhost$|^127\.0\.0\.1$/.test(window.location.hostname);
export const IS_DEV = isLocalNetwork || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// 로깅 헬퍼
const ENABLE_DEBUG_LOGS = false; // 디버깅 로그 활성화 여부 (필요시 true로 변경)

export const log = {
    info: (...args) => ENABLE_DEBUG_LOGS && console.log('[v2]', ...args),
    warn: (...args) => console.warn('[v2]', ...args),
    error: (...args) => console.error('[v2]', ...args),
    debug: (...args) => ENABLE_DEBUG_LOGS && console.debug('[v2]', ...args)
};

export default CONFIG;

