/**
 * Firebase Admin SDK를 사용한 인증 미들웨어
 * Firebase ID 토큰을 검증하여 req.user에 사용자 정보 설정
 */

// Firebase Admin은 동적으로 import하여 빌드 단계에서 에러 방지
let admin = null;
let getAuth = null;

export async function getFirebaseAdmin() {
    if (!admin) {
        const firebaseAdmin = await import('firebase-admin');
        admin = firebaseAdmin.default;
        
        // ✅ getAuth 확인 및 로깅
        console.log('[Firebase] 🔍 Checking firebaseAdmin module structure:', {
            hasDefault: !!firebaseAdmin.default,
            hasGetAuth: !!firebaseAdmin.getAuth,
            hasAuth: typeof firebaseAdmin.default?.auth === 'function',
            moduleKeys: Object.keys(firebaseAdmin)
        });
        
        // ✅ getAuth가 없으면 admin.auth()를 사용하는 래퍼 함수 생성
        if (firebaseAdmin.getAuth) {
            getAuth = firebaseAdmin.getAuth;
        } else {
            // getAuth가 없는 경우 admin.auth()를 사용하는 래퍼 함수 생성
            getAuth = (app) => {
                const targetApp = app || admin.app();
                return targetApp.auth();
            };
            console.log('[Firebase] ⚠️ getAuth not found in module, using admin.auth() wrapper');
        }
        
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
                
                // ✅ 초기화된 앱의 실제 프로젝트 ID 확인 및 로깅
                const initializedApp = admin.app();
                const appOptions = initializedApp.options;
                const actualProjectId = appOptions.projectId || appOptions.credential?.projectId || projectId;
                
                console.log('✅ Firebase Admin SDK initialized');
                console.log('[Firebase] 🔍 Project ID Configuration:', {
                    fromEnv: projectId,
                    fromAppOptions: appOptions.projectId,
                    fromCredential: appOptions.credential?.projectId,
                    actualProjectId: actualProjectId,
                    clientEmail: clientEmail,
                    expectedProjectId: 'worldad-8be07',
                    projectMatch: actualProjectId === 'worldad-8be07'
                });
                
                // ✅ 프로젝트 ID 불일치 경고
                if (actualProjectId !== 'worldad-8be07') {
                    console.error('[Firebase] ⚠️⚠️⚠️ PROJECT ID MISMATCH DETECTED!', {
                        actualProjectId: actualProjectId,
                        expectedProjectId: 'worldad-8be07',
                        fromEnv: projectId,
                        warning: 'Backend is using a different Firebase project than frontend!'
                    });
                }
            } catch (error) {
                // ✅ 초기화 실패 시 상세 에러 로깅 (조언에 따라 원문 에러 명확히 표시)
                console.error('[Firebase] ❌❌❌ Initialization failed - ORIGINAL ERROR:', {
                    code: error.code,
                    message: error.message,
                    name: error.name,
                    stack: error.stack,
                    errorInfo: error.errorInfo,
                    cause: error.cause,
                    fullError: error
                });
                console.error('[Firebase] ❌ Initialization failed - Environment check:', {
                    hasProjectId: !!projectId,
                    projectId: projectId,
                    hasPrivateKey: !!privateKey,
                    privateKeyLength: privateKey?.length,
                    hasClientEmail: !!clientEmail,
                    clientEmail: clientEmail
                });
                throw error;
            }
        }
    }
    return { admin, getAuth };
}

/**
 * 선택적 인증 미들웨어 (Public API용)
 * 토큰이 있으면 검증하고, 없으면 req.user = null로 설정하여 계속 진행
 */
export async function optionalAuthenticateToken(req, res, next) {
    // ⚡ 공개 API: 항상 게스트 접근 허용 (인증 선택적)
    const authHeader = req.headers.authorization;
    
    // ⚡ 디버깅: 항상 로그 출력
    console.log(`[Auth] 🔍 Optional auth called: ${req.method} ${req.originalUrl}`, {
        hasAuthHeader: !!authHeader,
        authHeaderPrefix: authHeader ? authHeader.substring(0, 20) : 'none'
    });
    
    // 토큰이 없으면 게스트 모드로 계속 진행 (공개 API)
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        req.user = null;
        console.log(`[Auth] ✅ No token provided, allowing guest access for ${req.method} ${req.originalUrl}`);
        return next(); // ⚡ 바로 next() 호출하여 라우트 핸들러로 진행
    }
    
    // 토큰이 있으면 검증 시도 (실패해도 게스트 모드로 진행)
    try {
        const firebaseAdmin = await getFirebaseAdmin();
        const token = authHeader.split(' ')[1];
        
        if (!token || token.trim().length === 0) {
            console.log(`[Auth] ⚠️ Empty token, allowing guest access`);
            req.user = null;
            return next();
        }
        
        // Firebase Admin으로 토큰 검증
        const auth = firebaseAdmin.getAuth(firebaseAdmin.admin.app());
        const decodedToken = await auth.verifyIdToken(token);
        
        // 검증 성공 시 사용자 정보 설정
        req.user = {
            uid: decodedToken.uid,
            email: decodedToken.email,
            firebase_uid: decodedToken.uid
        };
        console.log(`[Auth] ✅ Token verified for user ${decodedToken.uid}`);
        return next();
    } catch (error) {
        // 토큰 검증 실패 시에도 게스트 모드로 진행 (공개 API)
        console.log(`[Auth] ⚠️ Token verification failed (${error.message}), allowing guest access for ${req.method} ${req.originalUrl}`);
        req.user = null;
        return next();
    }
}

/**
 * Firebase ID 토큰 검증 미들웨어
 * Authorization: Bearer <token> 헤더에서 토큰을 추출하여 검증
 */
export async function authenticateToken(req, res, next) {
    // ✅ 토큰과 payload를 함수 스코프에서 접근 가능하도록 선언
    let token = null;
    let tokenPayload = null;
    let tokenProjectId = null;
    
    try {
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'No token provided' });
        }
        
        token = authHeader.split(' ')[1];
        
        // ✅ 토큰 추출 및 기본 검증
        if (!token || token.trim().length === 0) {
            console.error('[Auth] ❌ Empty token extracted from header');
            return res.status(401).json({ 
                error: 'Invalid token format',
                errorType: 'malformed',
                errorCode: 'EMPTY_TOKEN'
            });
        }
        
        // ✅ 토큰 payload 디코딩 (프로젝트 ID 확인용)
        let tokenPayload = null;
        let tokenProjectId = null;
        try {
            const tokenParts = token.split('.');
            if (tokenParts.length === 3) {
                tokenPayload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString());
                tokenProjectId = tokenPayload.aud || tokenPayload.iss?.split('/').pop();
            }
        } catch (decodeError) {
            console.warn('[Auth] ⚠️ Failed to decode token payload for inspection:', decodeError.message);
        }
        
        // ✅ 토큰 정보 로깅 (요청 시작 시)
        console.log('[Auth] 🔍 Verifying token:', {
            tokenLength: token.length,
            tokenPreview: token.substring(0, 50) + '...',
            tokenProjectId: tokenProjectId,
            backendProjectId: process.env.FIREBASE_PROJECT_ID,
            projectMatch: tokenProjectId === process.env.FIREBASE_PROJECT_ID,
            endpoint: req.path,
            method: req.method
        });
        
        // ✅ 프로젝트 ID 불일치 사전 경고
        if (tokenProjectId && tokenProjectId !== process.env.FIREBASE_PROJECT_ID) {
            console.error('[Auth] ⚠️⚠️⚠️ PROJECT ID MISMATCH BEFORE VERIFICATION!', {
                tokenProjectId: tokenProjectId,
                backendProjectId: process.env.FIREBASE_PROJECT_ID,
                tokenIss: tokenPayload?.iss,
                tokenAud: tokenPayload?.aud,
                warning: 'Token was issued for a different project than backend is configured for!'
            });
        }
        
        // Firebase Admin 동적 로드 및 토큰 검증
        let fbAdmin, fbGetAuth;
        try {
            const result = await getFirebaseAdmin();
            fbAdmin = result.admin;
            fbGetAuth = result.getAuth;
            
            // ✅ getAuth 확인
            console.log('[Auth] 🔍 getFirebaseAdmin() result:', {
                hasAdmin: !!fbAdmin,
                hasGetAuth: !!fbGetAuth,
                getAuthType: typeof fbGetAuth,
                adminAppsCount: fbAdmin?.apps?.length || 0
            });
            
            if (!fbGetAuth) {
                throw new Error('getAuth is undefined after getFirebaseAdmin()');
            }
        } catch (initError) {
            // ✅ getFirebaseAdmin() 자체에서 발생하는 에러 처리 (조언에 따라 원문 에러 명확히 표시)
            console.error('[Auth] ❌❌❌ getFirebaseAdmin() failed - ORIGINAL ERROR:', {
                code: initError.code,
                message: initError.message,
                name: initError.name,
                stack: initError.stack,
                errorInfo: initError.errorInfo,
                cause: initError.cause,
                fullError: initError
            });
            
            // AUTH_INIT_ERROR로 명확히 표시
            initError.code = 'AUTH_INIT_ERROR';
            throw initError;
        }
        
        // ✅ Firebase Admin SDK 정보 확인
        const appOptions = fbAdmin.app().options;
        const actualBackendProjectId = appOptions.projectId || process.env.FIREBASE_PROJECT_ID;
        
        console.log('[Auth] 🔍 Firebase Admin SDK info:', {
            appsCount: fbAdmin.apps.length,
            projectIdFromEnv: process.env.FIREBASE_PROJECT_ID,
            projectIdFromApp: appOptions.projectId,
            actualBackendProjectId: actualBackendProjectId,
            tokenProjectId: tokenProjectId,
            projectMatch: tokenProjectId === actualBackendProjectId,
            hasClientEmail: !!process.env.FIREBASE_CLIENT_EMAIL,
            hasGetAuth: typeof fbGetAuth === 'function',
            getAuthType: typeof fbGetAuth
        });
        
        // ✅ 프로젝트 ID 불일치 최종 경고
        if (tokenProjectId && tokenProjectId !== actualBackendProjectId) {
            console.error('[Auth] ❌❌❌ CRITICAL: PROJECT ID MISMATCH!', {
                tokenProjectId: tokenProjectId,
                backendProjectId: actualBackendProjectId,
                fromEnv: process.env.FIREBASE_PROJECT_ID,
                fromApp: appOptions.projectId,
                message: 'This verification will fail because token and backend are for different projects!'
            });
        }
        
        // ✅ getAuth 함수 확인 및 Auth 인스턴스 가져오기
        let auth;
        try {
            if (typeof fbGetAuth !== 'function') {
                const error = new Error(`getAuth is not a function. Type: ${typeof fbGetAuth}, Value: ${fbGetAuth}`);
                error.code = 'AUTH_INIT_ERROR';
                throw error;
            }
            
            auth = fbGetAuth();
            if (!auth) {
                const error = new Error('Failed to get Auth instance from getAuth()');
                error.code = 'AUTH_INIT_ERROR';
                throw error;
            }
            
            if (typeof auth.verifyIdToken !== 'function') {
                const error = new Error(`verifyIdToken is not a function. Type: ${typeof auth.verifyIdToken}`);
                error.code = 'AUTH_INIT_ERROR';
                throw error;
            }
            
            console.log('[Auth] 🔍 Auth instance ready:', {
                hasVerifyIdToken: true
            });
        } catch (initError) {
            // ✅ Auth 초기화 에러 상세 로깅 (조언에 따라 원문 에러 명확히 표시)
            console.error('[Auth] ❌❌❌ Auth initialization error - ORIGINAL ERROR:', {
                code: initError.code,
                message: initError.message,
                name: initError.name,
                stack: initError.stack,
                errorInfo: initError.errorInfo,
                cause: initError.cause,
                fullError: initError,
                hasGetAuth: typeof fbGetAuth,
                getAuthValue: fbGetAuth
            });
            
            // AUTH_INIT_ERROR로 명확히 표시
            if (!initError.code) {
                initError.code = 'AUTH_INIT_ERROR';
            }
            throw initError;
        }
        
        // ✅ 토큰 검증 시도
        let decodedToken;
        try {
            decodedToken = await auth.verifyIdToken(token);
        } catch (verifyError) {
            // ✅ Firebase Admin SDK 오류를 그대로 전달
            console.error('[Auth] ❌ verifyIdToken error:', {
                code: verifyError.code,
                message: verifyError.message,
                name: verifyError.name,
                stack: verifyError.stack?.substring(0, 500)
            });
            throw verifyError;
        }
        
        // ✅ 토큰 검증 성공 로깅
        console.log('[Auth] ✅ Token verified successfully:', {
            uid: decodedToken.uid,
            email: decodedToken.email,
            projectId: decodedToken.aud
        });
        
        // req.user에 사용자 정보 설정
        req.user = {
            uid: decodedToken.uid,
            email: decodedToken.email,
            name: decodedToken.name,
            picture: decodedToken.picture,
        };
        
        next();
    } catch (error) {
        // ✅ 토큰 검증 실패 원인 구분 (조언에 따라)
        let errorType = 'unknown';
        let errorMessage = 'Invalid or expired token';
        
        // ✅ AUTH_INIT_ERROR인 경우 별도 처리 (조언에 따라)
        if (error.code === 'AUTH_INIT_ERROR') {
            errorType = 'auth_init_error';
            errorMessage = 'Firebase Admin SDK initialization failed - server authentication setup error';
            
            console.error('[Auth] ❌❌❌ AUTH_INIT_ERROR - Server authentication initialization failed:', {
                code: error.code,
                message: error.message,
                name: error.name,
                stack: error.stack,
                errorInfo: error.errorInfo,
                cause: error.cause,
                fullError: error,
                warning: 'This is NOT a token problem - the backend cannot verify tokens because Admin SDK initialization failed!'
            });
            
            return res.status(401).json({ 
                error: errorMessage,
                errorType: errorType,
                errorCode: error.code,
                errorName: error.name,
                details: error.message || 'Firebase Admin SDK initialization failed',
                debug: process.env.NODE_ENV === 'development' ? {
                    message: error.message,
                    code: error.code,
                    name: error.name,
                    stack: error.stack?.substring(0, 500)
                } : undefined
            });
        }
        
        // ✅ 먼저 전체 오류 정보 로깅
        console.error('[Auth] ❌ Token verification error:', {
            code: error.code,
            message: error.message,
            name: error.name,
            stack: error.stack?.substring(0, 500)
        });
        
        // ✅ Firebase Admin SDK 오류 코드별 분류
        const errorCode = error.code || '';
        const errorMsg = (error.message || '').toLowerCase();
        const errorCodeLower = errorCode.toLowerCase();
        
        // ✅ 모든 오류 속성 로깅 (조언에 따라 구체적인 에러 코드 확인)
        console.error('[Auth] 🔍 Full error object:', {
            code: error.code,
            message: error.message,
            name: error.name,
            stack: error.stack?.substring(0, 500),
            errorKeys: Object.keys(error),
            errorString: String(error),
            // Firebase Admin SDK 특정 속성들
            errorInfo: error.errorInfo,
            cause: error.cause
        });
        
        // ✅ 토큰과 백엔드 프로젝트 ID 비교 로깅
        if (tokenPayload) {
            console.error('[Auth] 🔍 Token vs Backend Project Comparison:', {
                tokenAud: tokenPayload.aud,
                tokenIss: tokenPayload.iss,
                backendProjectId: process.env.FIREBASE_PROJECT_ID,
                projectMatch: tokenPayload.aud === process.env.FIREBASE_PROJECT_ID,
                tokenExp: tokenPayload.exp,
                tokenIat: tokenPayload.iat,
                isExpired: Date.now() > (tokenPayload.exp * 1000),
                expDate: new Date(tokenPayload.exp * 1000).toISOString(),
                now: new Date().toISOString()
            });
        }
        
        // 프로젝트 불일치 (aud/iss mismatch)
        if (errorCodeLower.includes('project') || 
            errorCodeLower.includes('audience') ||
            errorCodeLower.includes('issuer') ||
            errorCode === 'auth/invalid-argument' ||
            errorMsg.includes('project_id') ||
            errorMsg.includes('audience') ||
            errorMsg.includes('issuer') ||
            errorMsg.includes('project mismatch') ||
            errorMsg.includes('wrong project')) {
            errorType = 'project_mismatch';
            errorMessage = 'Token project mismatch - token was issued for a different Firebase project';
            console.error('[Auth] ❌ Project mismatch detected:', {
                message: error.message,
                code: errorCode,
                expectedProject: process.env.FIREBASE_PROJECT_ID
            });
        }
        // 시간/만료 문제 (exp, iat)
        else if (errorCode === 'auth/id-token-expired' ||
                 errorCodeLower.includes('expired') ||
                 errorCodeLower.includes('exp') ||
                 errorCodeLower.includes('iat') ||
                 errorMsg.includes('expired') ||
                 errorMsg.includes('exp') ||
                 errorMsg.includes('iat') ||
                 errorMsg.includes('not yet valid') ||
                 errorMsg.includes('token expired')) {
            errorType = 'expired';
            errorMessage = 'Token expired or not yet valid';
            console.error('[Auth] ❌ Token expired:', {
                message: error.message,
                code: errorCode
            });
        }
        // 서명/형식 오류
        else if (errorCode === 'auth/invalid-id-token' ||
                 errorCode === 'auth/argument-error' ||
                 errorCodeLower.includes('signature') ||
                 errorCodeLower.includes('malformed') ||
                 errorCodeLower.includes('invalid') ||
                 errorMsg.includes('signature') ||
                 errorMsg.includes('malformed') ||
                 errorMsg.includes('invalid token') ||
                 errorMsg.includes('invalid signature')) {
            errorType = 'malformed';
            errorMessage = 'Token format or signature invalid';
            console.error('[Auth] ❌ Token malformed:', {
                message: error.message,
                code: errorCode
            });
        }
        // 기타 오류
        else {
            console.error('[Auth] ❌ Unknown token verification error:', {
                message: error.message,
                code: errorCode,
                name: error.name,
                fullError: error,
                errorString: String(error),
                errorJSON: JSON.stringify(error, Object.getOwnPropertyNames(error))
            });
        }
        
        // ✅ 토큰 일부 정보 로깅 (디버깅용, 민감 정보는 제외)
        try {
            const tokenParts = token.split('.');
            if (tokenParts.length === 3) {
                const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString());
                const isExpired = Date.now() > payload.exp * 1000;
                const projectMatch = payload.aud === process.env.FIREBASE_PROJECT_ID;
                
                console.error('[Auth] ❌ Token verification failed - Token payload info:', {
                    iss: payload.iss,
                    aud: payload.aud,
                    expectedProject: process.env.FIREBASE_PROJECT_ID,
                    projectMatch: projectMatch,
                    exp: payload.exp,
                    iat: payload.iat,
                    email: payload.email,
                    uid: payload.uid,
                    expDate: new Date(payload.exp * 1000).toISOString(),
                    now: new Date().toISOString(),
                    isExpired: isExpired,
                    tokenLength: token.length,
                    tokenPreview: token.substring(0, 50) + '...'
                });
                
                // ✅ 프로젝트 불일치 경고
                if (!projectMatch) {
                    console.error('[Auth] ❌❌❌ PROJECT ID MISMATCH!', {
                        tokenAud: payload.aud,
                        expectedProject: process.env.FIREBASE_PROJECT_ID,
                        tokenIss: payload.iss
                    });
                }
                
                // ✅ 토큰 만료 경고
                if (isExpired) {
                    console.error('[Auth] ❌❌❌ TOKEN EXPIRED!', {
                        expDate: new Date(payload.exp * 1000).toISOString(),
                        now: new Date().toISOString(),
                        expiredBy: Math.floor((Date.now() - payload.exp * 1000) / 1000) + ' seconds'
                    });
                }
            }
        } catch (decodeError) {
            console.warn('[Auth] Failed to decode token for debugging:', decodeError);
        }
        
        return res.status(401).json({ 
            error: errorMessage,
            errorType: errorType,
            details: error.message || 'No error details available',
            errorCode: error.code || 'NO_CODE',
            errorName: error.name || 'Error',
            // 개발 환경에서만 상세 정보 포함
            debug: process.env.NODE_ENV === 'development' ? {
                message: error.message,
                code: error.code,
                name: error.name,
                stack: error.stack?.substring(0, 200)
            } : undefined
        });
    }
}

