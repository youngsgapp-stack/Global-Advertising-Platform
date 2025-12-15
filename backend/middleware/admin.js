/**
 * 관리자 인증 미들웨어
 * Firebase 인증 후 관리자 이메일 확인
 */

// 관리자 이메일 목록 (admin.js와 동일하게 유지)
const ADMIN_EMAILS = [
    'admin@billionairemap.com',
    'young91@naver.com',
    'q886654@naver.com',
    'etgbajy@gmail.com',
];

/**
 * 관리자 권한 확인 미들웨어
 * authenticateToken 이후에 사용
 */
export function requireAdmin(req, res, next) {
    const userEmail = req.user?.email;
    
    if (!userEmail) {
        return res.status(401).json({ error: 'User email not found' });
    }
    
    if (!ADMIN_EMAILS.includes(userEmail)) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    
    next();
}

