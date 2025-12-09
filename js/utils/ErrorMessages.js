/**
 * ErrorMessages - 에러 타입별 표준 메시지 정의
 * 
 * 모든 사용자 대면 에러 메시지를 한국어로 통일하고, 에러 타입별로 표준 메시지를 제공
 */

/**
 * 에러 타입 상수
 */
export const ERROR_TYPE = {
    // 인증 관련
    AUTH_REQUIRED: 'auth_required',
    AUTH_FAILED: 'auth_failed',
    AUTH_EXPIRED: 'auth_expired',
    
    // 영토 관련
    TERRITORY_NOT_FOUND: 'territory_not_found',
    TERRITORY_ALREADY_OWNED: 'territory_already_owned',
    TERRITORY_ALREADY_RULED: 'territory_already_ruled',
    TERRITORY_NO_OWNER: 'territory_no_owner',
    TERRITORY_INVALID_ID: 'territory_invalid_id',
    TERRITORY_COUNTRY_INFO_MISSING: 'territory_country_info_missing',
    
    // 경매 관련
    AUCTION_NOT_FOUND: 'auction_not_found',
    AUCTION_ALREADY_EXISTS: 'auction_already_exists',
    AUCTION_ALREADY_IN_PROGRESS: 'auction_already_in_progress',
    AUCTION_NOT_ACTIVE: 'auction_not_active',
    AUCTION_ENDED: 'auction_ended',
    BID_TOO_LOW: 'bid_too_low',
    BID_INSUFFICIENT_BALANCE: 'bid_insufficient_balance',
    
    // 결제 관련
    PAYMENT_INSUFFICIENT_BALANCE: 'payment_insufficient_balance',
    PAYMENT_FAILED: 'payment_failed',
    PAYMENT_DUPLICATE: 'payment_duplicate',
    PAYMENT_CANCELLED: 'payment_cancelled',
    
    // 픽셀 아트 관련
    PIXEL_ART_OWNERSHIP_CHANGED: 'pixel_art_ownership_changed',
    PIXEL_ART_SAVE_FAILED: 'pixel_art_save_failed',
    PIXEL_ART_LOAD_FAILED: 'pixel_art_load_failed',
    
    // 네트워크 관련
    NETWORK_ERROR: 'network_error',
    NETWORK_OFFLINE: 'network_offline',
    NETWORK_TIMEOUT: 'network_timeout',
    
    // 서버 관련
    SERVER_ERROR: 'server_error',
    SERVER_UNAVAILABLE: 'server_unavailable',
    FIRESTORE_ERROR: 'firestore_error',
    FIRESTORE_TIMESTAMP_UNAVAILABLE: 'firestore_timestamp_unavailable',
    
    // 일반
    UNKNOWN_ERROR: 'unknown_error',
    OPERATION_FAILED: 'operation_failed',
    INVALID_INPUT: 'invalid_input'
};

/**
 * 에러 메시지 맵
 */
const ERROR_MESSAGES = {
    // 인증 관련
    [ERROR_TYPE.AUTH_REQUIRED]: '로그인이 필요합니다',
    [ERROR_TYPE.AUTH_FAILED]: '로그인에 실패했습니다',
    [ERROR_TYPE.AUTH_EXPIRED]: '로그인 세션이 만료되었습니다. 다시 로그인해주세요',
    
    // 영토 관련
    [ERROR_TYPE.TERRITORY_NOT_FOUND]: '영토를 찾을 수 없습니다',
    [ERROR_TYPE.TERRITORY_ALREADY_OWNED]: '이미 소유하고 있는 영토입니다',
    [ERROR_TYPE.TERRITORY_ALREADY_RULED]: '이미 소유된 영토입니다',
    [ERROR_TYPE.TERRITORY_NO_OWNER]: '이 영토에는 소유자가 없습니다',
    [ERROR_TYPE.TERRITORY_INVALID_ID]: '영토 ID가 필요하며 비어있지 않은 문자열이어야 합니다',
    [ERROR_TYPE.TERRITORY_COUNTRY_INFO_MISSING]: '경매를 생성할 수 없습니다: 영토에 국가 정보가 필요합니다',
    
    // 경매 관련
    [ERROR_TYPE.AUCTION_NOT_FOUND]: '경매를 찾을 수 없습니다',
    [ERROR_TYPE.AUCTION_ALREADY_EXISTS]: '이미 진행 중인 경매가 있습니다',
    [ERROR_TYPE.AUCTION_ALREADY_IN_PROGRESS]: '이미 진행 중인 경매가 있습니다',
    [ERROR_TYPE.AUCTION_NOT_ACTIVE]: '경매가 활성 상태가 아닙니다',
    [ERROR_TYPE.AUCTION_ENDED]: '경매가 종료되었습니다',
    [ERROR_TYPE.BID_TOO_LOW]: '최소 입찰가보다 낮습니다',
    [ERROR_TYPE.BID_INSUFFICIENT_BALANCE]: '잔액이 부족합니다',
    
    // 결제 관련
    [ERROR_TYPE.PAYMENT_INSUFFICIENT_BALANCE]: '포인트 잔액이 부족합니다',
    [ERROR_TYPE.PAYMENT_FAILED]: '결제에 실패했습니다',
    [ERROR_TYPE.PAYMENT_DUPLICATE]: '이미 처리된 결제입니다',
    [ERROR_TYPE.PAYMENT_CANCELLED]: '결제가 취소되었습니다',
    
    // 픽셀 아트 관련
    [ERROR_TYPE.PIXEL_ART_OWNERSHIP_CHANGED]: '이 영토의 소유권이 변경되었습니다',
    [ERROR_TYPE.PIXEL_ART_SAVE_FAILED]: '픽셀 아트 저장에 실패했습니다',
    [ERROR_TYPE.PIXEL_ART_LOAD_FAILED]: '픽셀 아트를 불러오는데 실패했습니다',
    
    // 네트워크 관련
    [ERROR_TYPE.NETWORK_ERROR]: '네트워크 오류가 발생했습니다',
    [ERROR_TYPE.NETWORK_OFFLINE]: '오프라인 상태입니다. 인터넷 연결을 확인해주세요',
    [ERROR_TYPE.NETWORK_TIMEOUT]: '요청 시간이 초과되었습니다. 다시 시도해주세요',
    
    // 서버 관련
    [ERROR_TYPE.SERVER_ERROR]: '서버 오류가 발생했습니다',
    [ERROR_TYPE.SERVER_UNAVAILABLE]: '서버를 사용할 수 없습니다',
    [ERROR_TYPE.FIRESTORE_ERROR]: '데이터베이스 오류가 발생했습니다',
    [ERROR_TYPE.FIRESTORE_TIMESTAMP_UNAVAILABLE]: 'Firestore Timestamp를 사용할 수 없습니다',
    
    // 일반
    [ERROR_TYPE.UNKNOWN_ERROR]: '알 수 없는 오류가 발생했습니다',
    [ERROR_TYPE.OPERATION_FAILED]: '작업에 실패했습니다',
    [ERROR_TYPE.INVALID_INPUT]: '잘못된 입력입니다'
};

/**
 * 에러 메시지 가져오기
 * 
 * @param {string} errorType - 에러 타입 (ERROR_TYPE 상수)
 * @param {Object} params - 메시지에 삽입할 파라미터 (선택적)
 * @returns {string} 한국어 에러 메시지
 */
export function getErrorMessage(errorType, params = {}) {
    let message = ERROR_MESSAGES[errorType] || ERROR_MESSAGES[ERROR_TYPE.UNKNOWN_ERROR];
    
    // 파라미터 치환
    if (params && Object.keys(params).length > 0) {
        Object.keys(params).forEach(key => {
            message = message.replace(`{${key}}`, params[key]);
        });
    }
    
    return message;
}

/**
 * 에러 객체에서 에러 타입 추출 및 메시지 반환
 * 
 * @param {Error} error - 에러 객체
 * @returns {string} 한국어 에러 메시지
 */
export function getErrorMessageFromError(error) {
    if (!error || !error.message) {
        return ERROR_MESSAGES[ERROR_TYPE.UNKNOWN_ERROR];
    }
    
    const errorMessage = error.message.toLowerCase();
    
    // 인증 관련
    if (errorMessage.includes('authentication') || errorMessage.includes('auth') || errorMessage.includes('login')) {
        if (errorMessage.includes('required') || errorMessage.includes('필요')) {
            return ERROR_MESSAGES[ERROR_TYPE.AUTH_REQUIRED];
        }
        return ERROR_MESSAGES[ERROR_TYPE.AUTH_FAILED];
    }
    
    // 영토 관련
    if (errorMessage.includes('territory')) {
        if (errorMessage.includes('not found') || errorMessage.includes('찾을 수 없')) {
            return ERROR_MESSAGES[ERROR_TYPE.TERRITORY_NOT_FOUND];
        }
        if (errorMessage.includes('already owned') || errorMessage.includes('이미 소유')) {
            return ERROR_MESSAGES[ERROR_TYPE.TERRITORY_ALREADY_OWNED];
        }
        if (errorMessage.includes('already ruled') || errorMessage.includes('이미 소유된')) {
            return ERROR_MESSAGES[ERROR_TYPE.TERRITORY_ALREADY_RULED];
        }
        if (errorMessage.includes('no owner') || errorMessage.includes('소유자가 없')) {
            return ERROR_MESSAGES[ERROR_TYPE.TERRITORY_NO_OWNER];
        }
        if (errorMessage.includes('country') || errorMessage.includes('국가')) {
            return ERROR_MESSAGES[ERROR_TYPE.TERRITORY_COUNTRY_INFO_MISSING];
        }
    }
    
    // 경매 관련
    if (errorMessage.includes('auction')) {
        if (errorMessage.includes('not found') || errorMessage.includes('찾을 수 없')) {
            return ERROR_MESSAGES[ERROR_TYPE.AUCTION_NOT_FOUND];
        }
        if (errorMessage.includes('already exists') || errorMessage.includes('이미 진행 중')) {
            return ERROR_MESSAGES[ERROR_TYPE.AUCTION_ALREADY_EXISTS];
        }
        if (errorMessage.includes('in progress') || errorMessage.includes('진행 중')) {
            return ERROR_MESSAGES[ERROR_TYPE.AUCTION_ALREADY_IN_PROGRESS];
        }
        if (errorMessage.includes('not active') || errorMessage.includes('활성 상태가 아님')) {
            return ERROR_MESSAGES[ERROR_TYPE.AUCTION_NOT_ACTIVE];
        }
        if (errorMessage.includes('ended') || errorMessage.includes('종료')) {
            return ERROR_MESSAGES[ERROR_TYPE.AUCTION_ENDED];
        }
    }
    
    // 입찰 관련
    if (errorMessage.includes('bid') || errorMessage.includes('입찰')) {
        if (errorMessage.includes('minimum') || errorMessage.includes('최소')) {
            return ERROR_MESSAGES[ERROR_TYPE.BID_TOO_LOW];
        }
        if (errorMessage.includes('balance') || errorMessage.includes('잔액')) {
            return ERROR_MESSAGES[ERROR_TYPE.BID_INSUFFICIENT_BALANCE];
        }
    }
    
    // 결제 관련
    if (errorMessage.includes('payment') || errorMessage.includes('결제')) {
        if (errorMessage.includes('duplicate') || errorMessage.includes('이미 처리')) {
            return ERROR_MESSAGES[ERROR_TYPE.PAYMENT_DUPLICATE];
        }
        if (errorMessage.includes('balance') || errorMessage.includes('잔액')) {
            return ERROR_MESSAGES[ERROR_TYPE.PAYMENT_INSUFFICIENT_BALANCE];
        }
        return ERROR_MESSAGES[ERROR_TYPE.PAYMENT_FAILED];
    }
    
    // 네트워크 관련
    if (errorMessage.includes('network') || errorMessage.includes('네트워크')) {
        if (errorMessage.includes('offline') || errorMessage.includes('오프라인')) {
            return ERROR_MESSAGES[ERROR_TYPE.NETWORK_OFFLINE];
        }
        if (errorMessage.includes('timeout') || errorMessage.includes('시간 초과')) {
            return ERROR_MESSAGES[ERROR_TYPE.NETWORK_TIMEOUT];
        }
        return ERROR_MESSAGES[ERROR_TYPE.NETWORK_ERROR];
    }
    
    // Firestore 관련
    if (errorMessage.includes('firestore') || errorMessage.includes('timestamp')) {
        return ERROR_MESSAGES[ERROR_TYPE.FIRESTORE_TIMESTAMP_UNAVAILABLE];
    }
    
    // 기본값: 원본 메시지 반환 (이미 한국어일 수 있음)
    return error.message;
}

