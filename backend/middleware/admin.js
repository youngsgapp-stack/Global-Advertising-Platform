/**
 * 관리자 인증 미들웨어
 * Firebase 인증 후 관리자 이메일 확인
 */

// 관리자 이메일 목록 (ADMIN_EMAILS 환경변수가 있으면 우선 사용, 쉼표 구분)
const DEFAULT_ADMIN_EMAILS = [
    'admin@billionairemap.com',
    'young91@naver.com',
    'q886654@naver.com',
    'etgbajy@gmail.com',
];

export const ADMIN_EMAILS = process.env.ADMIN_EMAILS
    ? process.env.ADMIN_EMAILS.split(',').map(email => email.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_ADMIN_EMAILS;

/**
 * 인증된 사용자(req.user)가 관리자인지 확인
 */
export function isAdminUser(user) {
    const email = user?.email?.toLowerCase();
    return !!email && ADMIN_EMAILS.includes(email);
}

/**
 * 관리자 권한 확인 미들웨어
 * authenticateToken 이후에 사용
 */
export function requireAdmin(req, res, next) {
    if (!req.user?.email) {
        return res.status(401).json({ error: 'User email not found' });
    }
    
    if (!isAdminUser(req.user)) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    
    next();
}
