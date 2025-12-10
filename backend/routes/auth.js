/**
 * Auth API Routes
 * 인증 관련 엔드포인트 (토큰 검증 등)
 */

import express from 'express';

const router = express.Router();

/**
 * GET /api/auth/verify
 * 토큰 검증 (테스트용)
 */
router.get('/verify', (req, res) => {
    res.json({ 
        message: 'Use authenticated endpoints to verify token',
        note: 'Token verification is handled by authenticateToken middleware'
    });
});

export { router as authRouter };

