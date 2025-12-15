/**
 * Winston 로깅 시스템
 */

import winston from 'winston';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { combine, timestamp, printf, colorize, errors } = winston.format;

// 로그 디렉토리 생성 (없으면)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logsDir = path.join(__dirname, '..', 'logs');

if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// 커스텀 포맷
const logFormat = printf(({ level, message, timestamp, stack, ...metadata }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    
    // 스택 트레이스 (에러)
    if (stack) {
        msg += `\n${stack}`;
    }
    
    // 메타데이터
    if (Object.keys(metadata).length > 0) {
        msg += ` ${JSON.stringify(metadata)}`;
    }
    
    return msg;
});

// 로거 생성
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: combine(
        errors({ stack: true }),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        logFormat
    ),
    transports: [
        // 콘솔 출력 (개발 환경)
        new winston.transports.Console({
            format: combine(
                colorize(),
                logFormat
            )
        }),
        
        // 에러 로그 파일
        new winston.transports.File({
            filename: path.join(logsDir, 'error.log'),
            level: 'error',
            maxsize: 5242880, // 5MB
            maxFiles: 5
        }),
        
        // 전체 로그 파일
        new winston.transports.File({
            filename: path.join(logsDir, 'combined.log'),
            maxsize: 5242880, // 5MB
            maxFiles: 5
        })
    ],
    
    // 예외 처리
    exceptionHandlers: [
        new winston.transports.File({ filename: path.join(logsDir, 'exceptions.log') })
    ],
    
    // 프로미스 거부 처리
    rejectionHandlers: [
        new winston.transports.File({ filename: path.join(logsDir, 'rejections.log') })
    ]
});

// 프로덕션 환경에서는 JSON 포맷 사용
if (process.env.NODE_ENV === 'production') {
    logger.format = winston.format.json();
}

export default logger;

