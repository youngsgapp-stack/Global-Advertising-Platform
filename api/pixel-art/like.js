/**
 * 픽셀 아트 좋아요 API
 * Vercel Serverless Function
 * 
 * 사용자가 픽셀 아트 작품에 좋아요를 누르거나 취소할 수 있습니다.
 */

import admin from 'firebase-admin';

// Firebase Admin 초기화
let adminInitialized = false;

function initializeAdmin() {
    if (adminInitialized) return;
    
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
        
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }
        
        adminInitialized = true;
    } catch (error) {
        console.error('[Pixel Art Like] Failed to initialize Firebase Admin:', error);
        throw error;
    }
}

export default async function handler(req, res) {
    // CORS 헤더 설정
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    // OPTIONS 요청 처리
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    try {
        initializeAdmin();
        const db = admin.firestore();
        
        const { territoryId, userId, userName } = req.body;
        
        // 필수 파라미터 검증
        if (!territoryId || !userId) {
            return res.status(400).json({
                success: false,
                error: 'territoryId and userId are required'
            });
        }
        
        const now = admin.firestore.FieldValue.serverTimestamp();
        
        // 좋아요 추가 (POST) 또는 취소 (DELETE)
        if (req.method === 'POST') {
            // 중복 좋아요 체크
            const existingLike = await db.collection('pixel_art_likes')
                .where('territoryId', '==', territoryId)
                .where('userId', '==', userId)
                .limit(1)
                .get();
            
            if (!existingLike.empty) {
                return res.status(200).json({
                    success: true,
                    message: 'Already liked',
                    liked: true
                });
            }
            
            // 좋아요 추가
            const likeId = `like_${territoryId}_${userId}_${Date.now()}`;
            await db.collection('pixel_art_likes').doc(likeId).set({
                territoryId,
                userId,
                userName: userName || 'Anonymous',
                createdAt: now
            });
            
            // 픽셀 아트의 좋아요 수 업데이트
            const pixelCanvasRef = db.collection('pixelCanvases').doc(territoryId);
            await pixelCanvasRef.update({
                likeCount: admin.firestore.FieldValue.increment(1),
                updatedAt: now
            });
            
            return res.status(200).json({
                success: true,
                liked: true,
                message: 'Liked successfully'
            });
            
        } else if (req.method === 'DELETE') {
            // 좋아요 취소
            const likesSnapshot = await db.collection('pixel_art_likes')
                .where('territoryId', '==', territoryId)
                .where('userId', '==', userId)
                .get();
            
            if (likesSnapshot.empty) {
                return res.status(200).json({
                    success: true,
                    message: 'Not liked',
                    liked: false
                });
            }
            
            // 좋아요 삭제
            const batch = db.batch();
            likesSnapshot.docs.forEach(doc => {
                batch.delete(doc.ref);
            });
            await batch.commit();
            
            // 픽셀 아트의 좋아요 수 업데이트
            const pixelCanvasRef = db.collection('pixelCanvases').doc(territoryId);
            const pixelCanvasDoc = await pixelCanvasRef.get();
            if (pixelCanvasDoc.exists) {
                const currentLikes = pixelCanvasDoc.data().likeCount || 0;
                await pixelCanvasRef.update({
                    likeCount: Math.max(0, currentLikes - likesSnapshot.size),
                    updatedAt: now
                });
            }
            
            return res.status(200).json({
                success: true,
                liked: false,
                message: 'Unliked successfully'
            });
        } else {
            return res.status(405).json({
                success: false,
                error: 'Method not allowed. Use POST or DELETE.'
            });
        }
        
    } catch (error) {
        console.error('[Pixel Art Like] Error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
}

