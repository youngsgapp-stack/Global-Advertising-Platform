/**
 * Auction Serializer
 * 백엔드 응답을 프론트엔드 형식으로 일관되게 변환
 * ⚠️ 재발 방지: 모든 auction 응답은 이 함수를 거쳐야 함
 */

/**
 * DB row를 프론트엔드 형식으로 변환
 * @param {Object} row - DB에서 조회한 auction row (snake_case)
 * @returns {Object} 프론트엔드 형식 auction 객체 (camelCase)
 */
export function serializeAuction(row) {
    if (!row) {
        return null;
    }

    return {
        id: row.id,
        territoryId: row.territory_id,
        status: row.status,
        startingBid: parseFloat(row.min_bid || row.current_bid || 0),
        currentBid: parseFloat(row.current_bid || 0),
        highestBidder: row.current_bidder_id ? String(row.current_bidder_id) : null,
        highestBidderName: row.bidder_nickname || null,
        endTime: row.end_time,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        // 추가 필드
        territoryName: row.territory_name || null,
        territoryCode: row.territory_code || null,
        // 보호 기간 관련 (있으면)
        protectionDays: row.protection_days || null,
        // ⚠️ 전문가 조언 반영: minNextBid와 increment 포함 (GET 엔드포인트에서 계산됨)
        minNextBid: row.minNextBid !== undefined ? parseFloat(row.minNextBid) : null,
        increment: row.increment !== undefined ? parseFloat(row.increment) : 1
    };
}

/**
 * 여러 auction rows를 일괄 변환
 * @param {Array} rows - DB에서 조회한 auction rows
 * @returns {Array} 프론트엔드 형식 auction 객체 배열
 */
export function serializeAuctions(rows) {
    if (!rows || !Array.isArray(rows)) {
        return [];
    }
    return rows.map(row => serializeAuction(row));
}

