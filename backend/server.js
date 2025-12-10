/**
 * WorldAd Backend API Server
 * Postgres + Redis + WebSocket 구조
 */

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import dotenv from 'dotenv';

// 환경 변수 로드
dotenv.config();

// 라우터 import
import { authRouter } from './routes/auth.js';
import { mapRouter } from './routes/map.js';
import { territoriesRouter } from './routes/territories.js';
import { auctionsRouter } from './routes/auctions.js';
import { auctionsListRouter } from './routes/auctions-list.js';
import { usersRouter } from './routes/users.js';

// 미들웨어
import { authenticateToken } from './middleware/auth.js';

// WebSocket 핸들러
import { setupWebSocket } from './websocket/index.js';

// DB/Redis 초기화
import { initDatabase } from './db/init.js';
import { initRedis } from './redis/init.js';

const app = express();
// Railway는 자동으로 PORT를 할당하므로, 정수로 파싱
const PORT = parseInt(process.env.PORT || '3000', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN?.split(',') || ['http://localhost:8888'];

// 미들웨어
app.use(cors({
    origin: CORS_ORIGIN,
    credentials: true
}));
app.use(express.json());

// 헬스체크
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// 라우터 (인증 필요 없는 것들)
app.use('/api/auth', authRouter);

// 라우터 (인증 필요)
app.use('/api/map', authenticateToken, mapRouter);
app.use('/api/territories', authenticateToken, territoriesRouter);
app.use('/api/auctions', authenticateToken, auctionsListRouter); // 목록 (GET /api/auctions)
app.use('/api/auctions', authenticateToken, auctionsRouter); // 상세/입찰 (GET/POST /api/auctions/:id)
app.use('/api/users', authenticateToken, usersRouter);

// 404 핸들러
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// 에러 핸들러
app.use((err, req, res, next) => {
    console.error('[Error]', err);
    res.status(err.status || 500).json({
        error: err.message || 'Internal server error'
    });
});

// HTTP 서버 생성 (WebSocket용)
const server = createServer(app);

// WebSocket 서버 설정
const wss = new WebSocketServer({ server });
setupWebSocket(wss);

// 서버 시작
async function startServer() {
    try {
        // DB 초기화
        await initDatabase();
        console.log('✅ Database connected');
        
        // Redis 초기화
        await initRedis();
        console.log('✅ Redis connected');
        
        // 서버 시작
        server.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
            console.log(`📡 WebSocket server ready`);
            console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

startServer();

