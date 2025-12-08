/**
 * 콘텐츠 자동 필터링 API
 * Vercel Serverless Function
 * 
 * 부적절한 콘텐츠를 자동으로 감지하고 필터링합니다.
 * - 키워드 필터링
 * - 이미지 분석 (향후 구현)
 * - 신고 기반 필터링
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
        console.error('[Auto Filter] Failed to initialize Firebase Admin:', error);
        throw error;
    }
}

// 금지 키워드 목록 (기본)
const BANNED_KEYWORDS = [
    // 욕설 및 비속어 (예시)
    'spam', 'scam', 'fake',
    // 추가 키워드는 환경 변수나 데이터베이스에서 로드 가능
];

// 금지 패턴 (정규식)
const BANNED_PATTERNS = [
    /(.)\1{10,}/, // 같은 문자 10번 이상 반복 (스팸)
    /[A-Z]{20,}/, // 대문자 20개 이상 (스팸)
];

export default async function handler(req, res) {
    // CORS 헤더 설정
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    // OPTIONS 요청 처리
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    // POST 요청만 허용
    if (req.method !== 'POST') {
        return res.status(405).json({ 
            success: false, 
            error: 'Method not allowed. Use POST.' 
        });
    }
    
    try {
        initializeAdmin();
        const db = admin.firestore();
        
        const { 
            territoryId,
            content,
            contentType // 'pixel_art', 'comment', 'territory_name'
        } = req.body;
        
        // 필수 파라미터 검증
        if (!content || !contentType) {
            return res.status(400).json({
                success: false,
                error: 'content and contentType are required'
            });
        }
        
        const violations = [];
        
        // 1. 키워드 필터링
        const lowerContent = content.toLowerCase();
        for (const keyword of BANNED_KEYWORDS) {
            if (lowerContent.includes(keyword.toLowerCase())) {
                violations.push({
                    type: 'banned_keyword',
                    keyword,
                    severity: 'medium'
                });
            }
        }
        
        // 2. 패턴 필터링
        for (const pattern of BANNED_PATTERNS) {
            if (pattern.test(content)) {
                violations.push({
                    type: 'banned_pattern',
                    pattern: pattern.toString(),
                    severity: 'low'
                });
            }
        }
        
        // 3. 신고 기반 필터링 (개선: 무작위 신고 남발 방지)
        if (territoryId) {
            const reportsSnapshot = await db.collection('abuse_reports')
                .where('territoryId', '==', territoryId)
                .where('status', '==', 'pending')
                .get();
            
            if (reportsSnapshot.size > 0) {
                // 신고자 신뢰도 체크
                const reporterIds = new Set();
                const reports = [];
                
                for (const reportDoc of reportsSnapshot.docs) {
                    const report = reportDoc.data();
                    reporterIds.add(report.reportedBy);
                    reports.push(report);
                }
                
                // 3-1. 신고자 수가 3명 이상인지 확인 (같은 사람이 여러 번 신고한 경우 제외)
                const uniqueReporters = reporterIds.size;
                
                // 3-2. 신고 시간 간격 체크 (같은 시간대에 여러 신고가 들어왔으면 의심)
                const reportTimes = reports.map(r => r.createdAt?.toMillis() || 0).sort((a, b) => a - b);
                const timeClusters = [];
                let currentCluster = [reportTimes[0]];
                
                for (let i = 1; i < reportTimes.length; i++) {
                    // 5분 이내 신고는 같은 클러스터로 간주
                    if (reportTimes[i] - reportTimes[i - 1] < 5 * 60 * 1000) {
                        currentCluster.push(reportTimes[i]);
                    } else {
                        timeClusters.push(currentCluster);
                        currentCluster = [reportTimes[i]];
                    }
                }
                timeClusters.push(currentCluster);
                
                // 3-3. 신고자 신뢰도 체크 (과거 신고 이력 확인)
                let trustedReporters = 0;
                for (const reporterId of reporterIds) {
                    // 신고자의 과거 신고 이력 확인
                    const reporterHistory = await db.collection('abuse_reports')
                        .where('reportedBy', '==', reporterId)
                        .where('status', '==', 'resolved')
                        .get();
                    
                    // 해결된 신고 중 실제 위반으로 판정된 비율
                    const validReports = reporterHistory.docs.filter(doc => {
                        const data = doc.data();
                        return data.resolution === 'violation_confirmed';
                    }).length;
                    
                    const totalResolved = reporterHistory.docs.length;
                    const trustScore = totalResolved > 0 ? validReports / totalResolved : 0;
                    
                    // 신뢰도가 0.5 이상이면 신뢰할 수 있는 신고자
                    if (trustScore >= 0.5 || totalResolved === 0) {
                        trustedReporters++;
                    }
                }
                
                // 3-4. 최종 판정
                // - 고유 신고자 3명 이상
                // - 신뢰할 수 있는 신고자가 2명 이상
                // - 시간 클러스터가 2개 이상 (같은 시간대 집중 신고가 아닌 경우)
                const isSuspiciousPattern = timeClusters.length === 1 && timeClusters[0].length >= 3;
                
                if (uniqueReporters >= 3 && trustedReporters >= 2 && !isSuspiciousPattern) {
                    violations.push({
                        type: 'multiple_reports',
                        reportCount: reportsSnapshot.size,
                        uniqueReporters,
                        trustedReporters,
                        severity: 'high'
                    });
                } else if (uniqueReporters >= 5) {
                    // 신고자가 5명 이상이면 신뢰도와 관계없이 검토 대상
                    violations.push({
                        type: 'multiple_reports',
                        reportCount: reportsSnapshot.size,
                        uniqueReporters,
                        trustedReporters,
                        severity: 'medium',
                        note: 'Requires manual review due to high report count'
                    });
                }
            }
        }
        
        // 4. 결과 반환
        const isBlocked = violations.some(v => v.severity === 'high') || 
                          violations.filter(v => v.severity === 'medium').length >= 2;
        
        return res.status(200).json({
            success: true,
            blocked: isBlocked,
            violations,
            message: isBlocked 
                ? 'This content violates our community guidelines.' 
                : 'Content is acceptable.'
        });
        
    } catch (error) {
        console.error('[Auto Filter] Error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
}

