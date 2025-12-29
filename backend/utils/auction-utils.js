/**
 * Auction Utility Functions
 * 옥션 관련 공통 유틸리티 함수
 */

/**
 * 보호 기간 종료 시각 계산
 * ✅ 모든 종료 로직(admin, cron, 복구)에서 동일한 계산 사용
 * 
 * @param {number} protectionDays - 보호 기간 (일수), 기본값 7일
 * @returns {Date} 보호 종료 시각
 */
export function calculateProtectionEndsAt(protectionDays = 7) {
    return new Date(Date.now() + protectionDays * 24 * 60 * 60 * 1000);
}

/**
 * 옥션 종료 성공 로그 출력
 * ✅ 종료 성공 시 상세 정보를 한 줄로 로깅
 * 
 * @param {Object} params
 * @param {string} params.auctionId - 옥션 ID
 * @param {string} params.territoryId - 영토 ID
 * @param {string|null} params.winnerUserId - 낙찰자 사용자 ID (없으면 null)
 * @param {Date} params.protectionEndsAt - 보호 종료 시각
 * @param {number} params.processingTimeMs - 처리 소요 시간 (밀리초)
 * @param {string} params.source - 종료 소스 ('admin', 'cron', 'recovery')
 */
export function logAuctionEndSuccess({ 
    auctionId, 
    territoryId, 
    winnerUserId, 
    protectionEndsAt, 
    processingTimeMs,
    source = 'unknown'
}) {
    console.log(`[Auction End Success] auctionId=${auctionId} territoryId=${territoryId} winnerUserId=${winnerUserId || 'null'} protectionEndsAt=${protectionEndsAt.toISOString()} processingTime=${processingTimeMs}ms source=${source}`);
}

