/**
 * 사용자가 하던 일(구매 등)을 잠시 기억해 두었다가 로그인/충전 후 이어서 진행
 * sessionStorage를 사용하므로 로그인 리다이렉트로 페이지가 새로 고쳐져도 유지됨
 */

const STORAGE_KEY = 'pendingIntent';
const MAX_AGE_MS = 30 * 60 * 1000;

/**
 * @param {{type: 'purchase'|'openTerritory', territoryId: string, [key: string]: any}} intent
 */
export function setPendingIntent(intent) {
    try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...intent, createdAt: Date.now() }));
    } catch (e) {
        // sessionStorage 사용 불가(사생활 보호 모드 등)면 이어가기만 생략
    }
}

/**
 * 해당 타입의 intent를 꺼내고 삭제 (없거나 만료됐으면 null)
 */
export function takePendingIntent(type) {
    let intent = null;
    try {
        intent = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
    } catch (e) {
        intent = null;
    }
    if (!intent || intent.type !== type) return null;
    sessionStorage.removeItem(STORAGE_KEY);
    if (Date.now() - (intent.createdAt || 0) > MAX_AGE_MS) return null;
    return intent;
}

export function clearPendingIntent() {
    try {
        sessionStorage.removeItem(STORAGE_KEY);
    } catch (e) {
        // ignore
    }
}
