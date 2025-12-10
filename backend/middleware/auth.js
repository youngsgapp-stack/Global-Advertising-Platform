/**
 * Firebase Admin SDK를 사용한 인증 미들웨어
 * Firebase ID 토큰을 검증하여 req.user에 사용자 정보 설정
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
                console.error('[Firebase] Missing required environment variables:');
                console.error('  FIREBASE_PROJECT_ID:', projectId ? '✓' : '✗ MISSING');
                console.error('  FIREBASE_PRIVATE_KEY:', privateKey ? '✓' : '✗ MISSING');
                console.error('  FIREBASE_CLIENT_EMAIL:', clientEmail ? '✓' : '✗ MISSING');
                throw new Error('Firebase Admin SDK environment variables are not set. Please check Railway Variables.');
            }
            
            try {
                admin.initializeApp({
                    credential: admin.credential.cert({
                        projectId: projectId,
                        privateKey: privateKey.replace(/\\n/g, '\n'),
                        clientEmail: clientEmail,
                    }),
                });
                console.log('✅ Firebase Admin SDK initialized');
            } catch (error) {
                console.error('[Firebase] Initialization failed:', error);
                throw error;
            }
        }
    }
    return { admin, getAuth };
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
        
        // Firebase Admin 동적 로드 및 토큰 검증
        const { admin: fbAdmin, getAuth: fbGetAuth } = await getFirebaseAdmin();
        const decodedToken = await fbGetAuth().verifyIdToken(token);
        
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

