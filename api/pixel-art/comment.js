/**
 * 픽셀 아트 댓글 API
 * Vercel Serverless Function
 * 
 * 사용자가 픽셀 아트 작품에 댓글을 작성, 수정, 삭제할 수 있습니다.
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
        console.error('[Pixel Art Comment] Failed to initialize Firebase Admin:', error);
        throw error;
    }
}

export default async function handler(req, res) {
    // CORS 헤더 설정
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    // OPTIONS 요청 처리
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    try {
        initializeAdmin();
        const db = admin.firestore();
        
        const { territoryId, userId, userName, commentId, content } = req.body;
        
        // GET: 댓글 목록 조회
        if (req.method === 'GET') {
            if (!territoryId) {
                return res.status(400).json({
                    success: false,
                    error: 'territoryId is required'
                });
            }
            
            const commentsSnapshot = await db.collection('pixel_art_comments')
                .where('territoryId', '==', territoryId)
                .orderBy('createdAt', 'desc')
                .limit(50)
                .get();
            
            const comments = commentsSnapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            
            return res.status(200).json({
                success: true,
                comments
            });
        }
        
        // POST: 댓글 작성
        if (req.method === 'POST') {
            if (!territoryId || !userId || !content) {
                return res.status(400).json({
                    success: false,
                    error: 'territoryId, userId, and content are required'
                });
            }
            
            // 내용 길이 제한
            if (content.length > 500) {
                return res.status(400).json({
                    success: false,
                    error: 'Comment content must be 500 characters or less'
                });
            }
            
            const now = admin.firestore.FieldValue.serverTimestamp();
            const commentId = `comment_${territoryId}_${userId}_${Date.now()}`;
            
            await db.collection('pixel_art_comments').doc(commentId).set({
                territoryId,
                userId,
                userName: userName || 'Anonymous',
                content: content.trim(),
                createdAt: now,
                updatedAt: now,
                edited: false
            });
            
            // 픽셀 아트의 댓글 수 업데이트
            const pixelCanvasRef = db.collection('pixelCanvases').doc(territoryId);
            await pixelCanvasRef.update({
                commentCount: admin.firestore.FieldValue.increment(1),
                updatedAt: now
            });
            
            return res.status(200).json({
                success: true,
                commentId,
                message: 'Comment added successfully'
            });
        }
        
        // PUT: 댓글 수정
        if (req.method === 'PUT') {
            if (!commentId || !userId || !content) {
                return res.status(400).json({
                    success: false,
                    error: 'commentId, userId, and content are required'
                });
            }
            
            const commentRef = db.collection('pixel_art_comments').doc(commentId);
            const commentDoc = await commentRef.get();
            
            if (!commentDoc.exists) {
                return res.status(404).json({
                    success: false,
                    error: 'Comment not found'
                });
            }
            
            const comment = commentDoc.data();
            if (comment.userId !== userId) {
                return res.status(403).json({
                    success: false,
                    error: 'You can only edit your own comments'
                });
            }
            
            // 내용 길이 제한
            if (content.length > 500) {
                return res.status(400).json({
                    success: false,
                    error: 'Comment content must be 500 characters or less'
                });
            }
            
            await commentRef.update({
                content: content.trim(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                edited: true
            });
            
            return res.status(200).json({
                success: true,
                message: 'Comment updated successfully'
            });
        }
        
        // DELETE: 댓글 삭제
        if (req.method === 'DELETE') {
            if (!commentId || !userId) {
                return res.status(400).json({
                    success: false,
                    error: 'commentId and userId are required'
                });
            }
            
            const commentRef = db.collection('pixel_art_comments').doc(commentId);
            const commentDoc = await commentRef.get();
            
            if (!commentDoc.exists) {
                return res.status(404).json({
                    success: false,
                    error: 'Comment not found'
                });
            }
            
            const comment = commentDoc.data();
            if (comment.userId !== userId) {
                return res.status(403).json({
                    success: false,
                    error: 'You can only delete your own comments'
                });
            }
            
            const territoryId = comment.territoryId;
            
            // 댓글 삭제
            await commentRef.delete();
            
            // 픽셀 아트의 댓글 수 업데이트
            const pixelCanvasRef = db.collection('pixelCanvases').doc(territoryId);
            const pixelCanvasDoc = await pixelCanvasRef.get();
            if (pixelCanvasDoc.exists) {
                const currentComments = pixelCanvasDoc.data().commentCount || 0;
                await pixelCanvasRef.update({
                    commentCount: Math.max(0, currentComments - 1),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }
            
            return res.status(200).json({
                success: true,
                message: 'Comment deleted successfully'
            });
        }
        
        return res.status(405).json({
            success: false,
            error: 'Method not allowed'
        });
        
    } catch (error) {
        console.error('[Pixel Art Comment] Error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
}

