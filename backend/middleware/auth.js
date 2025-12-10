/**
 * Firebase Admin SDK를 사용한 인증 미들웨어
 * Firebase ID 토큰을 검증하여 req.user에 사용자 정보 설정
 */

import admin from 'firebase-admin';
import { getAuth } from 'firebase-admin/auth';

// Firebase Admin 초기화
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        }),
    });
}

/**
 * Firebase ID 토큰 검증 미들웨어
 * Authorization: Bearer <token> 헤더에서 토큰을 추출하여 검증
 */
export async function authenticateToken(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'No token provided' });
        }
        
        const token = authHeader.split(' ')[1];
        
        // Firebase Admin으로 토큰 검증
        const decodedToken = await getAuth().verifyIdToken(token);
        
        // req.user에 사용자 정보 설정
        req.user = {
            uid: decodedToken.uid,
            email: decodedToken.email,
            name: decodedToken.name,
            picture: decodedToken.picture,
        };
        
        next();
    } catch (error) {
        console.error('[Auth] Token verification failed:', error);
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

