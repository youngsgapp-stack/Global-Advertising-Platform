/**
 * WebSocket 서버 설정
 * 실시간 업데이트 브로드캐스트
 */

// Firebase Admin은 동적으로 import하여 빌드 단계에서 에러 방지
let admin = null;
let getAuth = null;

async function getFirebaseAdmin() {
    if (!admin) {
        const firebaseAdmin = await import('firebase-admin');
        admin = firebaseAdmin.default;
        getAuth = firebaseAdmin.getAuth;
        
        // Firebase 초기화 확인
        if (!admin.apps.length) {
            const projectId = process.env.FIREBASE_PROJECT_ID;
            const privateKey = process.env.FIREBASE_PRIVATE_KEY;
            const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
            
            if (!projectId || !privateKey || !clientEmail) {
                throw new Error('Firebase Admin SDK environment variables are not set');
            }
            
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId: projectId,
                    privateKey: privateKey.replace(/\\n/g, '\n'),
                    clientEmail: clientEmail,
                }),
            });
        }
    }
    return { admin, getAuth };
}

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
            // Firebase Admin 동적 로드 및 토큰 검증
            const { admin: fbAdmin, getAuth } = await getFirebaseAdmin();
            const decodedToken = await getAuth().verifyIdToken(token);
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
        type: 'bid:created',
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
 * 경매 업데이트 브로드캐스트
 */
export function broadcastAuctionUpdate(auctionId, data) {
    const message = JSON.stringify({
        type: 'auction:updated',
        data: {
            auctionId,
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
    
    console.log(`📢 Broadcasted auction update to ${sentCount} connections`);
}

/**
 * 영토 업데이트 브로드캐스트
 */
export function broadcastTerritoryUpdate(territoryId, data) {
    const message = JSON.stringify({
        type: 'territory:updated',
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

/**
 * 픽셀 업데이트 브로드캐스트 (레거시 호환성)
 */
export function broadcastPixelUpdate(territoryId, data) {
    // 타일 업데이트인 경우 별도 처리
    if (data.type === 'PIXEL_TILES_UPDATED') {
        return broadcastPixelTilesUpdate(territoryId, data);
    }
    
    const message = JSON.stringify({
        type: 'pixel:updated',
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
    
    console.log(`📢 Broadcasted pixel update to ${sentCount} connections`);
}

/**
 * 타일 업데이트 브로드캐스트 (128×128 타일 시스템용)
 */
export function broadcastPixelTilesUpdate(territoryId, data) {
    const message = JSON.stringify({
        type: 'pixel:tiles:updated',
        data: {
            territoryId,
            territoryRevision: data.territoryRevision,
            updatedTiles: data.updatedTiles,
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
    
    console.log(`📢 Broadcasted pixel tiles update to ${sentCount} connections (${data.updatedTiles?.length || 0} tiles)`);
}