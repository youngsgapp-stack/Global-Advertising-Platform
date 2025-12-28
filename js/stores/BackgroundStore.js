/**
 * 배경 설정 싱글톤 스토어
 * 픽셀 편집 화면과 스탬프 배치 화면의 배경색을 동기화
 */

const STORAGE_KEY = 'pixel_editor_bg_v1';

let state = {
    mode: 'solid',          // 'solid' | 'checker'
    color: '#1a1a1a',
    checkerSize: 8
};

const listeners = new Set();

/**
 * localStorage에서 배경 설정 로드
 */
export function loadBg() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (saved) {
            state = { ...state, ...saved };
        }
    } catch (e) {
        // 파싱 실패 시 기본값 유지
    }
    return state;
}

/**
 * 현재 배경 설정 가져오기
 */
export function getBg() {
    return { ...state };
}

/**
 * 배경 설정 변경
 */
export function setBg(next) {
    state = { ...state, ...next };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    
    // 모든 구독자에게 알림
    listeners.forEach(fn => fn(state));
}

/**
 * 배경 설정 구독
 * @param {Function} callback - 상태 변경 시 호출될 콜백
 * @returns {Function} 구독 해제 함수
 */
export function subscribeBg(callback) {
    listeners.add(callback);
    // 즉시 현재 상태 전달
    callback(state);
    
    // 구독 해제 함수 반환
    return () => {
        listeners.delete(callback);
    };
}

// 초기 로드
loadBg();

