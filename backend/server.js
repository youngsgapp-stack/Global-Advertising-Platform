/**
 * WorldAd Backend API Server
 * Postgres + Redis + WebSocket 구조
 */

// ==========================================
// 🔍 1단계: 버전 배너 (최신 코드 검증용)
// ==========================================
const BUILD_VERSION = '2025-01-11-02-FIX-001'; // 배포마다 변경하여 최신 코드 확인
console.log('🚀 ========================================');
console.log(`🚀 Build Version: ${BUILD_VERSION}`);
console.log(`🚀 ========================================`);

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import dotenv from 'dotenv';

// 환경 변수 로드
dotenv.config();

// ==========================================
// 🔍 2단계: 실험용 모드 (환경변수만 확인)
// ==========================================
const DEBUG_ENV_ONLY = process.env.DEBUG_ENV_ONLY === 'true';

if (DEBUG_ENV_ONLY) {
    console.log('🔍 ========================================');
    console.log('🔍 DEBUG MODE: Environment Variables Check Only');
    console.log('🔍 ========================================');
    console.log('Total env vars:', Object.keys(process.env).length);
    
    // DATABASE 관련 변수만 필터링
    const dbVars = Object.keys(process.env).filter(k => 
        k.includes('DATABASE') || k.includes('POSTGRES') || k.includes('DB')
    );
    console.log('Database-related vars:', dbVars.length > 0 ? dbVars : 'NONE');
    
    // DATABASE_URL 상세 정보
    const dbUrl = process.env.DATABASE_URL;
    console.log('\n📦 DATABASE_URL Analysis:');
    console.log('  exists:', !!dbUrl);
    console.log('  type:', typeof dbUrl);
    console.log('  length:', dbUrl ? dbUrl.length : 'N/A');
    
    if (dbUrl) {
        console.log('  preview:', dbUrl.substring(0, Math.min(60, dbUrl.length)) + (dbUrl.length > 60 ? '...' : ''));
        console.log('  first char:', `"${dbUrl[0]}"`);
        console.log('  last char:', `"${dbUrl[dbUrl.length - 1]}"`);
        console.log('  has leading space:', dbUrl[0] === ' ');
        console.log('  has trailing space:', dbUrl[dbUrl.length - 1] === ' ');
        console.log('  starts with quote:', dbUrl[0] === '"' || dbUrl[0] === "'");
        console.log('  ends with quote:', dbUrl[dbUrl.length - 1] === '"' || dbUrl[dbUrl.length - 1] === "'");
        console.log('  starts with postgresql://', dbUrl.startsWith('postgresql://'));
        console.log('  starts with postgres://', dbUrl.startsWith('postgres://'));
    } else {
        console.log('  ⚠️  DATABASE_URL is missing or undefined!');
    }
    
    console.log('\n🔍 ========================================');
    console.log('🔍 Check Complete - Exiting...');
    console.log('🔍 ========================================');
    process.exit(0); // 여기서 종료 (서버 실행 안 함)
}

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

// 루트 경로 (기본 응답)
app.get('/', (req, res) => {
    res.json({ 
        message: 'WorldAd Backend API Server',
        status: 'running',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        endpoints: {
            health: '/api/health',
            api: '/api'
        }
    });
});

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
        server.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 Server running on port ${PORT}`);
            console.log(`📡 WebSocket server ready`);
            console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`🔗 Health check: http://0.0.0.0:${PORT}/api/health`);
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

startServer();

