/**
 * WebSocket 서버 설정
 * 실시간 업데이트 브로드캐스트
 */

import { authenticateToken } from '../middleware/auth.js';
import admin from 'firebase-admin';

const connections = new Map(); // userId -> Set of WebSocket connections

/**
 * WebSocket 서버 설정
 */
export function setupWebSocket(wss) {
    wss.on('connection', async (ws, req) => {
        console.log('🔌 New WebSocket connection attempt');
        
        // 인증 처리 (쿼리 파라미터나 헤더에서 토큰 가져오기)
        const token = req.url.split('token=')[1]?.split('&')[0];
        
        if (!token) {
            ws.close(1008, 'No token provided');
            return;
        }
        
        try {
            // Firebase 토큰 검증
            const decodedToken = await admin.auth().verifyIdToken(token);
            const userId = decodedToken.uid;
            
            // 연결 저장
            if (!connections.has(userId)) {
                connections.set(userId, new Set());
            }
            connections.get(userId).add(ws);
            
            console.log(`✅ WebSocket authenticated: ${userId}`);
            
            // 연결 종료 시 정리
            ws.on('close', () => {
                const userConnections = connections.get(userId);
                if (userConnections) {
                    userConnections.delete(ws);
                    if (userConnections.size === 0) {
                        connections.delete(userId);
                    }
                }
                console.log(`🔌 WebSocket disconnected: ${userId}`);
            });
            
            // 에러 처리
            ws.on('error', (error) => {
                console.error(`❌ WebSocket error for ${userId}:`, error);
            });
            
            // 메시지 수신 처리 (필요시)
            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message);
                    console.log(`📨 WebSocket message from ${userId}:`, data);
                    // 필요시 처리 로직 추가
                } catch (error) {
                    console.error('Failed to parse WebSocket message:', error);
                }
            });
            
            // 연결 확인 메시지 전송
            ws.send(JSON.stringify({
                type: 'connected',
                timestamp: new Date().toISOString(),
            }));
            
        } catch (error) {
            console.error('❌ WebSocket authentication failed:', error);
            ws.close(1008, 'Invalid token');
        }
    });
}

/**
 * 입찰 업데이트 브로드캐스트
 */
export function broadcastBidUpdate(data) {
    const message = JSON.stringify({
        type: 'bidUpdate',
        data: {
            auctionId: data.auctionId,
            territoryId: data.territoryId,
            amount: data.amount,
            bidderId: data.bidderId,
            bidderNickname: data.bidderNickname,
            timestamp: new Date().toISOString(),
        }
    });
    
    // 모든 연결된 클라이언트에게 브로드캐스트
    let sentCount = 0;
    for (const [userId, userConnections] of connections.entries()) {
        for (const ws of userConnections) {
            if (ws.readyState === 1) { // OPEN
                ws.send(message);
                sentCount++;
            }
        }
    }
    
    console.log(`📢 Broadcasted bid update to ${sentCount} connections`);
}

/**
 * 영토 업데이트 브로드캐스트
 */
export function broadcastTerritoryUpdate(territoryId, data) {
    const message = JSON.stringify({
        type: 'territoryUpdate',
        data: {
            territoryId,
            ...data,
            timestamp: new Date().toISOString(),
        }
    });
    
    let sentCount = 0;
    for (const [userId, userConnections] of connections.entries()) {
        for (const ws of userConnections) {
            if (ws.readyState === 1) {
                ws.send(message);
                sentCount++;
            }
        }
    }
    
    console.log(`📢 Broadcasted territory update to ${sentCount} connections`);
}

