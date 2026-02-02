/**
 * Pixels API Routes
 * 픽셀 데이터 조회/저장
 */

import express from 'express';
import { fileURLToPath } from 'url';
import { query, getPool } from '../db/init.js';
import { redis } from '../redis/init.js';
import { CACHE_TTL, invalidatePixelCache } from '../redis/cache-utils.js';
import { broadcastPixelUpdate } from '../websocket/index.js';
import { validateTerritoryIdParam } from '../utils/territory-id-validator.js';
import logger from '../utils/logger.js';

// ES 모듈에서 __filename 사용을 위한 헬퍼
const __filename = fileURLToPath(import.meta.url);

// ⚠️ 로거 alias (기존 코드와의 호환성을 위해)
// ⚠️ 임시 fallback: logger가 없어도 동작하도록
const log = logger || {
    info: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => console.debug(...args)
};

// ⚠️ 운영 안정성: 타일 시스템 가드레일 상수
const TILE_SYSTEM_LIMITS = {
    MAX_TILES_PER_SAVE: 100,           // 저장 요청당 최대 타일 수
    MAX_TILE_PAYLOAD_SIZE_KB: 50,       // 타일당 최대 payload 크기 (KB)
    MAX_TILES_PER_TERRITORY: 64,        // 영토당 최대 타일 수 (16×16 기준: 8×8)
    PAYLOAD_ENCODING_VERSION: 1,        // 압축 payload 인코딩 버전
    EMPTY_TILE_MARKER: null,            // 빈 타일 표현 규칙
    SOLID_COLOR_THRESHOLD: 200          // 단색 타일 최적화 임계값
};

// 상위 레벨 라우터 (독립 라우트) - /api/pixels/* 경로용
const topLevelRouter = express.Router();

/**
 * GET /api/pixels/territories
 * 픽셀 데이터가 있는 영토 ID 목록 조회 (공개 API - 게스트 허용)
 * Redis에서 픽셀 데이터 메타 정보를 조회
 */
topLevelRouter.get('/territories', async (req, res) => {
    // ⚡ 공개 API: 게스트 접근 허용 (인증 불필요)
    console.log('[Pixels] ✅ GET /api/pixels/territories - Public API access (guest allowed)');
    console.log('[Pixels] Request details:', {
        method: req.method,
        url: req.url,
        originalUrl: req.originalUrl,
        path: req.path
    });
    try {
        // 캐시된 목록 먼저 확인
        const cacheKey = 'pixels:territories:list';
        const cached = await redis.get(cacheKey);
        
        if (cached) {
            console.log(`[Pixels] ⚠️ Returning cached data (count: ${cached.count || 0})`);
            return res.json(cached);
        }
        
        console.log(`[Pixels] No cache found, fetching from Set...`);
        
        // ⚡ 핵심 수정: KEYS/SCAN 대신 Set을 사용하여 픽셀이 있는 territory 목록 조회
        // Upstash Redis는 KEYS 명령을 지원하지 않으므로, Set으로 목록 관리
        const territoriesSetKey = 'pixels:territories:set';
        let territoryIds = [];
        
        try {
            // Set에서 모든 territoryId 조회
            territoryIds = await redis.smembers(territoriesSetKey) || [];
            console.log(`[Pixels] territories:set size=${territoryIds.length}`);
            console.log(`[Pixels] territories:set sample=`, (territoryIds || []).slice(0, 10));
            
            // ⚡ 디버깅: Set이 비어있으면 경고
            if (territoryIds.length === 0) {
                console.warn(`[Pixels] ⚠️ Set is empty! Run rebuild script if pixel data exists.`);
            }
        } catch (error) {
            console.warn('[Pixels] Failed to get territories from Set, trying fallback method:', error.message);
            // Set이 없거나 실패한 경우 빈 배열 (첫 실행 또는 Set이 아직 생성되지 않은 경우)
            territoryIds = [];
        }
        
        // ⚡ Set이 비어있으면 1회 SCAN으로 자동 재구축 (레거시 데이터 복구)
        // ⚠️ 주의: Upstash Redis는 SCAN을 지원하지 않으므로 일반 Redis에서만 동작
        if (territoryIds.length === 0) {
            console.warn('[Pixels] Set is empty. Attempting to rebuild via SCAN (one-time fallback for legacy data)...');
            
            try {
                const prefix = 'pixel_data:'; // 실제 픽셀 저장 키 패턴
                const rebuilt = new Set();
                
                // SCAN 시도 (Upstash는 빈 결과 반환, 일반 Redis만 동작)
                let cursor = '0';
                let scanAttempts = 0;
                const maxScanAttempts = 1000; // 무한 루프 방지
                
                do {
                    const scanResult = await redis.scan(cursor, { MATCH: `${prefix}*`, COUNT: 100 });
                    
                    // redis.scan 반환값 처리 (배열 또는 객체 형태)
                    let nextCursor = '0';
                    let keys = [];
                    
                    if (Array.isArray(scanResult)) {
                        // node-redis: [cursor, keys] 형태
                        nextCursor = scanResult[0] || '0';
                        keys = scanResult[1] || [];
                    } else if (typeof scanResult === 'object' && scanResult !== null) {
                        // 객체 형태: { cursor, keys } 또는 { cursor: [...], keys: [...] }
                        nextCursor = scanResult.cursor || scanResult[0] || '0';
                        keys = scanResult.keys || scanResult[1] || [];
                    } else {
                        // SCAN이 지원되지 않는 경우 (Upstash 등)
                        cursor = '0';
                        break;
                    }
                    
                    cursor = nextCursor;
                    
                    for (const key of keys) {
                        const territoryId = key.replace(prefix, '').trim();
                        if (territoryId) {
                            // 실제로 픽셀 데이터가 있는지 확인
                            const pixelData = await redis.get(key);
                            if (pixelData && pixelData.pixels && Array.isArray(pixelData.pixels) && pixelData.pixels.length > 0) {
                                rebuilt.add(territoryId);
                            }
                        }
                    }
                    
                    scanAttempts++;
                    if (scanAttempts >= maxScanAttempts) {
                        console.warn('[Pixels] SCAN reached max attempts, stopping');
                        break;
                    }
                } while (cursor !== '0');
                
                // 재구축된 territoryId들을 Set에 추가
                if (rebuilt.size > 0) {
                    const rebuiltArray = Array.from(rebuilt);
                    // 기존 Set 삭제 후 재생성 (깔끔한 재구축)
                    await redis.del(territoriesSetKey);
                    await redis.sadd(territoriesSetKey, ...rebuiltArray);
                    territoryIds = rebuiltArray;
                    console.log(`[Pixels] ✅ Rebuilt Set with ${territoryIds.length} territories from legacy Redis data`);
                } else {
                    console.warn('[Pixels] ⚠️ No legacy pixel data found via SCAN (Set will be populated on next save)');
                    console.warn('[Pixels] ⚠️ Note: Upstash Redis does not support SCAN command, so this fallback will not work');
                }
            } catch (error) {
                // SCAN 실패는 조용히 무시 (Upstash 등 SCAN 미지원 환경)
                console.debug('[Pixels] SCAN fallback failed (may not be supported):', error.message);
            }
        }
        
        const territoriesWithPixels = [];
        
        // ⚡ 디버깅: territoryIds가 있으면 로그
        if (territoryIds.length > 0) {
            console.log(`[Pixels] Processing ${territoryIds.length} territories from Set`);
        }
        
        // ⚡ 성능 최적화: MGET으로 일괄 조회 (개별 GET보다 훨씬 빠름)
        const t1 = Date.now();
        const pixelCacheKeys = territoryIds.map(id => `pixel_data:${id}`);
        const pixelDataArray = await redis.mget(pixelCacheKeys);
        const t2 = Date.now();
        
        console.log(`[Pixels] ⚡ MGET pixel data time: ${t2 - t1}ms for ${territoryIds.length} territories`);
        
        // 결과 처리 및 Set 정리
        const validTerritories = [];
        const territoriesToRemove = [];
        
        for (let i = 0; i < territoryIds.length; i++) {
            const territoryId = territoryIds[i];
            const pixelData = pixelDataArray[i];
            
            try {
                // ⚡ 디버깅: pixelData 조회 결과 로그
                console.log(`[Pixels] Checking ${territoryId}:`, {
                    hasData: !!pixelData,
                    hasPixels: !!(pixelData && pixelData.pixels && Array.isArray(pixelData.pixels)),
                    pixelsLength: pixelData && pixelData.pixels ? pixelData.pixels.length : 0
                });
                
                if (pixelData) {
                    // 픽셀이 실제로 있는 경우만 포함
                    if (pixelData.pixels && Array.isArray(pixelData.pixels) && pixelData.pixels.length > 0) {
                        const pixelCount = pixelData.pixels.length;
                        const totalPixels = (pixelData.width || 64) * (pixelData.height || 64);
                        const fillRatio = totalPixels > 0 ? pixelCount / totalPixels : null;
                        
                        console.log(`[Pixels] ✅ ${territoryId}: valid pixel data (${pixelCount} pixels)`);
                        
                        validTerritories.push({
                            territoryId: territoryId,
                            pixelCount: pixelCount,
                            hasPixelArt: true,
                            fillRatio: fillRatio,
                            updatedAt: pixelData.updatedAt || pixelData.lastUpdated || null,
                            hasOwner: !!pixelData.ownerId
                        });
                    } else {
                        // Set에는 있지만 실제 픽셀 데이터가 없는 경우
                        console.warn(`[Pixels] ⚠️ Territory ${territoryId} in Set but has no pixel data, marking for removal`);
                        territoriesToRemove.push(territoryId);
                    }
                } else {
                    // Set에는 있지만 Redis에 데이터가 없는 경우
                    console.warn(`[Pixels] ⚠️ Territory ${territoryId} in Set but no data in Redis, marking for removal`);
                    territoriesToRemove.push(territoryId);
                }
            } catch (err) {
                // 개별 처리 실패는 무시 (로깅만)
                console.error(`[Pixels] ❌ Failed to process pixel data for ${territoryId}:`, err.message);
            }
        }
        
        // Set 정리 (비동기로 실행하여 응답 지연 방지)
        if (territoriesToRemove.length > 0) {
            console.log(`[Pixels] Removing ${territoriesToRemove.length} invalid entries from Set`);
            redis.srem(territoriesSetKey, ...territoriesToRemove).catch(err => {
                console.warn('[Pixels] Failed to remove invalid entries from Set:', err.message);
            });
        }
        
        territoriesWithPixels.push(...validTerritories);
        
        // 영토 ID 목록 생성 (필터링은 프론트엔드에서 소유권 확인)
        const finalTerritoryIds = territoriesWithPixels.map(t => t.territoryId);
        
        // ⚡ 성능: limit 적용 (기본값 1000, 최대 5000)
        // 향후 픽셀아트가 많아져도 안정적으로 동작하도록 제한
        const limit = parseInt(req.query.limit) || 1000;
        const maxLimit = 5000;
        const effectiveLimit = Math.min(limit, maxLimit);
        
        const limitedTerritories = territoriesWithPixels.slice(0, effectiveLimit);
        const limitedTerritoryIds = limitedTerritories.map(t => t.territoryId);
        
        const response = {
            territoryIds: limitedTerritoryIds,
            count: limitedTerritoryIds.length,
            totalCount: finalTerritoryIds.length, // 전체 개수 (limit 적용 전)
            hasMore: finalTerritoryIds.length > effectiveLimit, // 더 있는지 여부
            territories: limitedTerritories // 메타 정보만 포함 (픽셀 전체 데이터는 포함하지 않음)
        };
        
        // ⚡ 디버깅: 응답 로그
        console.log(`[Pixels] GET /api/pixels/territories response:`, {
            territoryIdsCount: response.territoryIds.length,
            count: response.count,
            totalCount: response.totalCount,
            hasMore: response.hasMore,
            sampleIds: response.territoryIds.slice(0, 5)
        });
        
        // 캐시 저장
        await redis.set(cacheKey, response, CACHE_TTL.PIXEL_META);
        
        res.json(response);
    } catch (error) {
        logger.error('[Pixels] Error getting territories with pixels:', {
            error: error.message,
            stack: error.stack
        });
        res.status(500).json({ error: 'Failed to fetch territories with pixels' });
    }
});

// 하위 레벨 라우터 (territories 라우터에 마운트됨) - /api/territories/:territoryId/pixels 경로용
const router = express.Router({ mergeParams: true }); // territories 라우터의 params 상속

/**
 * GET /api/territories/:territoryId/pixels
 * 영토의 픽셀 데이터 조회
 */
router.get('/', async (req, res) => {
    // ⚠️ CP0: ENTER 로그 (최상단, 무조건 실행)
    const reqId = req.headers['x-request-id'] || `get-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const processId = process.pid;
    const routeFile = __filename.split(/[/\\]/).pop() || 'pixels.js';
    const commitHash = process.env.GIT_COMMIT || process.env.VERCEL_GIT_COMMIT_SHA || 'unknown';
    
    // ⚠️ 강제 식별 로그 (console.error로도 찍어서 로그 레벨 문제 회피)
    console.error(`[Pixels][GET] ENTER route=v2 pid=${processId} file=${routeFile} commit=${commitHash.substring(0, 7)} reqId=${reqId} ts=${new Date().toISOString()}`);
    logger.warn(`[Pixels][GET] ENTER route=v2 pid=${processId} file=${routeFile} commit=${commitHash.substring(0, 7)} reqId=${reqId}`, {
        territoryIdParam: req.params?.territoryId,
        url: req.url,
        method: req.method
    });
    
    // ⚠️ 응답 헤더에 경로 정보 추가 (디버깅용)
    res.setHeader('X-Pixels-Route', 'v2');
    res.setHeader('X-Pixels-Pid', String(processId));
    
    try {
        const { territoryId: territoryIdParam } = req.params;
        
        // ID 검증 및 Canonical ID 변환
        const idValidation = validateTerritoryIdParam(territoryIdParam, {
            strict: false,
            autoConvert: true,
            logWarning: true
        });
        
        if (!idValidation || !idValidation.canonicalId) {
            logger.error(`[Pixels] ❌ GET: Invalid territory ID`, {
                reqId,
                territoryIdRaw: territoryIdParam,
                error: idValidation?.error
            });
            return res.status(400).json({ 
                error: idValidation?.error || 'Invalid territory ID format',
                received: territoryIdParam
            });
        }
        
        const territoryId = idValidation.canonicalId;
        
        // ⚠️ CP1: territoryId normalized
        logger.warn(`[Pixels][GET] CP1 territoryId normalized`, {
            reqId,
            territoryIdRaw: territoryIdParam,
            territoryIdNormalized: territoryId,
            wasDisplayId: idValidation.wasDisplayId || false
        });
        res.setHeader('X-Pixels-CP', '1');
        
        // ⚠️ 진단용: 정규화된 ID와 Redis key 로깅
        const pixelCacheKey = `pixel_data:${territoryId}`;
        
        // ⚠️ CP2: read pixel_data done
        // Redis에서 먼저 조회
        // pixel_data:${territoryId} 키에서 실제 픽셀 데이터 조회
        const pixelDataRaw = await redis.get(pixelCacheKey);
        
        // ⚠️ 진단용: 조회한 데이터 확인
        let pixelData = null;
        let pixelsLen = 0;
        if (pixelDataRaw) {
            try {
                pixelData = typeof pixelDataRaw === 'string' ? JSON.parse(pixelDataRaw) : pixelDataRaw;
                pixelsLen = pixelData?.pixels?.length || 0;
            } catch (e) {
                logger.error(`[Pixels] ❌ GET: Failed to parse pixel data`, {
                    reqId,
                    territoryId,
                    redisKey: pixelCacheKey,
                    error: e.message
                });
            }
        }
        
        // ⚠️ CP2: read pixel_data done
        logger.warn(`[Pixels][GET] CP2 read pixel_data done`, {
            reqId,
            territoryId,
            redisKey: pixelCacheKey,
            hasData: !!pixelData,
            pixelsLength: pixelsLen,
            filledPixels: pixelData?.filledPixels || 0,
            revision: pixelData?.revision || 0,
            dataType: typeof pixelDataRaw,
            pixelDataKeys: pixelData ? Object.keys(pixelData) : [],
            pixelDataRawType: typeof pixelDataRaw,
            pixelDataRawIsNull: pixelDataRaw === null,
            pixelDataRawIsUndefined: pixelDataRaw === undefined
        });
        res.setHeader('X-Pixels-CP', '2');
        
        // ⚠️ 핵심: pixelDataValid 정의 고정 (빈 배열은 invalid)
        // 유효 데이터 = pixels가 배열이고 length > 0
        const pixelDataValid = pixelData && 
                               pixelData.pixels && 
                               Array.isArray(pixelData.pixels) && 
                               pixelData.pixels.length > 0;
        
        // ⚠️ CP3: pixelDataValid evaluated
        logger.warn(`[Pixels][GET] CP3 pixelDataValid evaluated`, {
            reqId,
            territoryId,
            pixelDataValid,
            hasPixelData: !!pixelData,
            hasPixelsProperty: !!(pixelData && pixelData.pixels),
            pixelsIsArray: !!(pixelData && pixelData.pixels && Array.isArray(pixelData.pixels)),
            pixelsLength: pixelData?.pixels?.length || 0
        });
        res.setHeader('X-Pixels-CP', '3');
        res.setHeader('X-Pixels-Valid', pixelDataValid ? 'true' : 'false');
        
        if (pixelDataValid) {
            // ⚠️ 개선: 메타데이터 보장 (캐시 일관성 검증용)
            // 기존 데이터에 메타데이터가 없으면 추가
            if (!pixelData.revision || !pixelData.updatedAt) {
                const now = Date.now();
                pixelData.revision = pixelData.revision || now; // 타임스탬프 기반 revision
                pixelData.updatedAt = pixelData.updatedAt || pixelData.lastUpdated || new Date().toISOString();
                // Redis에 업데이트된 메타데이터 저장
                await redis.set(pixelCacheKey, pixelData);
            }
            
            logger.warn(`[Pixels][GET] ✅ Returning cached pixel data`, {
                reqId,
                territoryId,
                pixelsLength: pixelData.pixels?.length || 0,
                filledPixels: pixelData.filledPixels || 0,
                revision: pixelData.revision,
                updatedAt: pixelData.updatedAt
            });
            res.setHeader('X-Pixels-Path', 'cache_valid');
            return res.json(pixelData);
        }
        
        // ⚠️ 캐시가 없거나 비어있으면 타일 시스템 확인
        logger.warn(`[Pixels][GET] ⚠️ No valid cached pixel data, checking tile system`, {
            reqId,
            territoryId,
            hasPixelData: !!pixelData,
            pixelsLength: pixelData?.pixels?.length || 0,
            pixelDataType: pixelData ? typeof pixelData : 'null'
        });
        res.setHeader('X-Pixels-Path', 'tile_fallback');
        
        // ⚠️ 타일 시스템에서 데이터 로드 (타일 기반 저장이 있는 경우)
        // 타일 시스템: 128x128 그리드, 16x16 타일, 8x8 = 64개 타일
        const TILE_SIZE = 16;
        const GRID_SIZE = 128;
        const TILES_X = Math.floor(GRID_SIZE / TILE_SIZE); // 8
        const TILES_Y = Math.floor(GRID_SIZE / TILE_SIZE); // 8
        
        // ⚠️ CP4: tileRevMap read done
        // 타일 리비전 맵 확인 (타일이 있는지 확인)
        const tileRevKey = `territory_tile_rev:${territoryId}`;
        let tileRevisionMap;
        try {
            tileRevisionMap = await redis.hgetall(tileRevKey);
        } catch (hgetallError) {
            logger.error(`[Pixels][GET] ❌ Failed to get tile revision map`, {
                reqId,
                territoryId,
                tileRevKey,
                error: hgetallError.message,
                stack: hgetallError.stack
            });
            tileRevisionMap = {};
        }
        
        // ⚠️ 타일 리비전 맵 정규화: null/undefined 체크 및 빈 객체 처리
        if (!tileRevisionMap || typeof tileRevisionMap !== 'object') {
            tileRevisionMap = {};
        }
        
        const tileRevisionMapKeys = Object.keys(tileRevisionMap);
        const tileRevisionMapLength = tileRevisionMapKeys.length;
        
        logger.warn(`[Pixels][GET] CP4 tileRevMap read done`, {
            reqId,
            territoryId,
            tileRevKey,
            hasTileRevisionMap: !!tileRevisionMap,
            tileRevisionMapType: typeof tileRevisionMap,
            tileRevisionMapKeys: tileRevisionMapKeys,
            tileRevisionMapLength: tileRevisionMapLength,
            tileRevisionMapSample: tileRevisionMapLength > 0 ? Object.entries(tileRevisionMap).slice(0, 3) : [],
            tileRevisionMapIsEmpty: tileRevisionMapLength === 0
        });
        res.setHeader('X-Pixels-CP', '4');
        res.setHeader('X-Pixels-TileCount', String(tileRevisionMapLength));
        
        if (tileRevisionMapLength > 0) {
            // ⚠️ CP5: tile merge done
            // 타일이 있으면 모든 타일을 로드하여 조합
            logger.warn(`[Pixels][GET] 🔍 Loading tiles from tile system`, {
                reqId,
                territoryId,
                tileCount: Object.keys(tileRevisionMap).length,
                tileIds: Object.keys(tileRevisionMap).slice(0, 10) // 처음 10개만
            });
            
            const allPixels = [];
            let latestUpdatedAt = null;
            let maxRevision = 0;
            
            // 모든 타일 로드 (타일 리비전 맵에 있는 타일만 로드)
            const tileIds = Object.keys(tileRevisionMap);
            
            logger.warn(`[Pixels][GET] 🔍 Loading ${tileIds.length} tiles from tile system`, {
                reqId,
                territoryId,
                tileIds: tileIds.slice(0, 10) // 처음 10개만 로그
            });
            
            let tilesLoaded = 0;
            let tilesWithPixels = 0;
            let tilesEmpty = 0;
            let tilesError = 0;
            
            for (const tileId of tileIds) {
                const tileKey = `tile_data:${tileId}`;
                let tileDataRaw;
                try {
                    tileDataRaw = await redis.get(tileKey);
                } catch (getError) {
                    logger.warn(`[Pixels][GET] ⚠️ Failed to get tile data for ${tileId}`, {
                        reqId,
                        territoryId,
                        tileId,
                        tileKey,
                        error: getError.message
                    });
                    tilesError++;
                    continue;
                }
                
                if (tileDataRaw) {
                    tilesLoaded++;
                    try {
                        // redis.get()은 이미 파싱된 객체를 반환할 수 있음
                        const tileData = typeof tileDataRaw === 'string' ? JSON.parse(tileDataRaw) : tileDataRaw;
                        
                        if (!tileData) {
                            logger.warn(`[Pixels][GET] ⚠️ Tile data is null/undefined for ${tileId}`, {
                                reqId,
                                territoryId,
                                tileId
                            });
                            tilesEmpty++;
                            continue;
                        }
                        
                        if (tileData && tileData.pixels && Array.isArray(tileData.pixels) && tileData.pixels.length > 0) {
                            tilesWithPixels++;
                            // ⚠️ 타일 좌표계 검증: 픽셀 좌표가 타일 로컬 좌표(0~15)인지 글로벌 좌표(0~127)인지 확인
                            // 타일 저장 계약: tile_data에는 로컬 좌표(0~15)만 저장되어야 함
                            // 하지만 클라이언트가 글로벌 좌표로 저장했을 수 있으므로 검증 필요
                            
                            // 타일 좌표 추출 (tileId에서)
                            const parts = tileId.split(':');
                            let tileX = 0, tileY = 0;
                            if (parts.length === 3) {
                                tileX = parseInt(parts[1]) || 0;
                                tileY = parseInt(parts[2]) || 0;
                            }
                            
                            // 픽셀 좌표 변환: 로컬 좌표면 글로벌로 변환, 글로벌 좌표면 그대로 사용
                            const transformedPixels = tileData.pixels.map(pixel => {
                                // 좌표 범위로 로컬/글로벌 판단 (0~15면 로컬, 0~127면 글로벌)
                                const isLocalCoords = pixel.x < TILE_SIZE && pixel.y < TILE_SIZE;
                                
                                if (isLocalCoords) {
                                    // 로컬 좌표를 글로벌 좌표로 변환
                                    return {
                                        x: tileX * TILE_SIZE + pixel.x,
                                        y: tileY * TILE_SIZE + pixel.y,
                                        color: pixel.color
                                    };
                                } else {
                                    // 이미 글로벌 좌표면 그대로 사용
                                    return pixel;
                                }
                            });
                            
                            // 타일의 픽셀을 전체 픽셀 배열에 추가
                            allPixels.push(...transformedPixels);
                            
                            logger.debug(`[Pixels][GET] ✅ Loaded tile ${tileId} with ${transformedPixels.length} pixels`, {
                                reqId,
                                territoryId,
                                tileId,
                                pixelsCount: transformedPixels.length,
                                totalPixelsSoFar: allPixels.length
                            });
                        } else {
                            // 타일 데이터는 있지만 픽셀이 없음
                            tilesEmpty++;
                            logger.debug(`[Pixels][GET] ⚠️ Tile ${tileId} has no pixels`, {
                                reqId,
                                territoryId,
                                tileId,
                                hasTileData: !!tileData,
                                hasPixelsProperty: !!(tileData && tileData.pixels),
                                pixelsIsArray: !!(tileData && tileData.pixels && Array.isArray(tileData.pixels)),
                                pixelsLength: tileData?.pixels?.length || 0
                            });
                        }
                        
                        // 최신 업데이트 시간 추적
                        if (tileData && tileData.updatedAt) {
                            const tileUpdated = new Date(tileData.updatedAt).getTime();
                            if (!latestUpdatedAt || tileUpdated > new Date(latestUpdatedAt).getTime()) {
                                latestUpdatedAt = tileData.updatedAt;
                            }
                        }
                        
                        // 최대 리비전 추적
                        if (tileData && tileData.revision) {
                            const tileRevision = parseInt(tileData.revision) || 0;
                            if (tileRevision > maxRevision) {
                                maxRevision = tileRevision;
                            }
                        }
                    } catch (parseError) {
                        tilesError++;
                        logger.warn(`[Pixels][GET] ❌ Failed to parse tile data for ${tileId}`, {
                            reqId,
                            territoryId,
                            tileId,
                            error: parseError.message,
                            stack: parseError.stack,
                            tileDataRawType: typeof tileDataRaw
                        });
                    }
                } else {
                    // 타일 데이터가 Redis에 없음
                    tilesEmpty++;
                    logger.warn(`[Pixels][GET] ⚠️ Tile data not found in Redis for ${tileId}`, {
                        reqId,
                        territoryId,
                        tileId,
                        tileKey
                    });
                }
            }
            
            logger.warn(`[Pixels][GET] 📊 Tile loading summary`, {
                reqId,
                territoryId,
                totalTilesInMap: tileIds.length,
                tilesLoaded,
                tilesWithPixels,
                tilesEmpty,
                tilesError,
                totalPixelsCollected: allPixels.length
            });
            
            // 타일 메타데이터 확인
            const metaKey = `territory_meta:${territoryId}`;
            const metadataRaw = await redis.get(metaKey);
            let metadata = null;
            if (metadataRaw) {
                try {
                    // redis.get()은 이미 파싱된 객체를 반환할 수 있음
                    metadata = typeof metadataRaw === 'string' ? JSON.parse(metadataRaw) : metadataRaw;
                } catch (e) {
                    logger.warn(`[Pixels] Failed to parse metadata for ${territoryId}:`, e.message);
                }
            }
            
            // ⚠️ 빈 배열 캐시 저장 금지: pixelsLength=0이면 pixel_data에 저장하지 않음
            // 또는 state=EMPTY로 명시하여 invalid로 처리
            if (allPixels.length === 0) {
                logger.warn(`[Pixels][GET] ⚠️ No pixels found in tiles, not caching empty data`, {
                    reqId,
                    territoryId,
                    tileCount: tileIds.length
                });
                res.setHeader('X-Pixels-Path', 'tile_empty');
                
                // 빈 데이터 반환 (캐시하지 않음)
                const emptyPixelData = {
                    territoryId,
                    pixels: [],
                    width: GRID_SIZE,
                    height: GRID_SIZE,
                    filledPixels: 0,
                    lastUpdated: null,
                    revision: metadata?.territoryRevision || maxRevision || Date.now(),
                    updatedAt: latestUpdatedAt || new Date().toISOString()
                };
                return res.json(emptyPixelData);
            }
            
            // 타일 데이터를 pixel_data 형식으로 변환
            const combinedPixelData = {
                territoryId,
                pixels: allPixels,
                width: GRID_SIZE,
                height: GRID_SIZE,
                filledPixels: allPixels.length,
                lastUpdated: latestUpdatedAt,
                revision: metadata?.territoryRevision || maxRevision || Date.now(),
                updatedAt: latestUpdatedAt || new Date().toISOString()
            };
            
            // ⚠️ pixel_data 키에 캐시 (다음 요청 시 빠른 조회)
            // ⚠️ redis.set()은 내부에서 JSON.stringify를 처리하므로 객체를 직접 전달
            await redis.set(pixelCacheKey, combinedPixelData);
            
            logger.warn(`[Pixels][GET] ✅ Cached combined tile data`, {
                reqId,
                territoryId,
                pixelsLength: allPixels.length,
                cacheKey: pixelCacheKey
            });
            
            // ⚠️ CP5: tile merge done
            logger.warn(`[Pixels][GET] CP5 tile merge done`, {
                reqId,
                territoryId,
                pixelsLength: allPixels.length,
                filledPixels: allPixels.length,
                revision: combinedPixelData.revision,
                width: combinedPixelData.width,
                height: combinedPixelData.height,
                tilesProcessed: tileIds.length,
                tilesWithData: allPixels.length > 0 ? tileIds.length : 0
            });
            res.setHeader('X-Pixels-CP', '5');
            res.setHeader('X-Pixels-Path', allPixels.length > 0 ? 'tile_merged' : 'tile_empty');
            res.setHeader('X-Pixels-PixelsCount', String(allPixels.length));
            
            return res.json(combinedPixelData);
        } else {
            // ⚠️ CP5: tile merge done (no tiles)
            // 타일 리비전 맵이 비어있지만, 혹시 타일 데이터가 직접 저장되어 있을 수 있으므로 확인
            logger.warn(`[Pixels][GET] CP5 tile merge done (no tiles in revision map)`, {
                reqId,
                territoryId,
                tileRevKey,
                tileRevisionMap: tileRevisionMap,
                tileRevisionMapType: typeof tileRevisionMap,
                tileRevisionMapIsNull: tileRevisionMap === null,
                tileRevisionMapIsUndefined: tileRevisionMap === undefined,
                tileRevisionMapLength: tileRevisionMapLength
            });
            
            // ⚠️ 안전장치: 타일 리비전 맵이 비어있어도 타일 데이터가 있을 수 있음 (race condition 등)
            // 예상되는 타일 ID 패턴으로 직접 확인 (territoryId:tileX:tileY)
            // 하지만 이는 비용이 많이 들 수 있으므로, 일단 로그만 남기고 스킵
            // 실제 문제가 발생하면 이 부분을 활성화하여 타일을 직접 검색할 수 있음
            logger.debug(`[Pixels][GET] ⚠️ Tile revision map is empty, but tiles might exist. Skipping direct tile search for performance.`, {
                reqId,
                territoryId
            });
            
            res.setHeader('X-Pixels-CP', '5');
            res.setHeader('X-Pixels-Path', 'tile_missing');
        }
        
        // ⚠️ 레거시 캐시 확인 (pixels:${territoryId})
        const cacheKey = `pixels:${territoryId}`;
        const cached = await redis.get(cacheKey);
        
        // ⚠️ 레거시 캐시도 유효성 검사 필요 (빈 배열은 invalid)
        const cachedValid = cached && 
                           cached.pixels && 
                           Array.isArray(cached.pixels) && 
                           cached.pixels.length > 0;
        
        if (cachedValid) {
            // ⚠️ 개선: 메타데이터 보장
            if (!cached.revision || !cached.updatedAt) {
                const now = Date.now();
                cached.revision = cached.revision || now;
                cached.updatedAt = cached.updatedAt || cached.lastUpdated || new Date().toISOString();
                await redis.set(cacheKey, cached, CACHE_TTL.PIXEL_META);
            }
            logger.warn(`[Pixels][GET] ✅ Returning legacy cached pixel data`, {
                reqId,
                territoryId,
                pixelsLength: cached.pixels?.length || 0
            });
            res.setHeader('X-Pixels-Path', 'legacy_cache');
            return res.json(cached);
        }
        
        // ⚠️ 모든 소스에서 픽셀을 찾지 못함 - 빈 데이터 반환 (캐시하지 않음)
        logger.warn(`[Pixels][GET] ⚠️ No pixels found from any source`, {
            reqId,
            territoryId,
            checkedSources: ['pixel_data', 'tile_system', 'legacy_cache']
        });
        res.setHeader('X-Pixels-Path', 'empty');
        
        const now = Date.now();
        const emptyPixelData = {
            territoryId,
            pixels: [],
            width: 64,
            height: 64,
            filledPixels: 0,
            lastUpdated: null,
            revision: now,
            updatedAt: new Date().toISOString()
        };
        
        // ⚠️ 빈 배열 캐시 저장 금지: pixelsLength=0이면 저장하지 않음
        // res.json(emptyPixelData);
        
        res.json(emptyPixelData);
    } catch (error) {
        // ⚠️ 에러 발생 시에도 경로 정보 헤더 추가
        res.setHeader('X-Pixels-Path', 'error');
        res.setHeader('X-Pixels-Error', error.message || 'unknown');
        
        logger.error(`[Pixels][GET] ❌ Error`, {
            reqId,
            territoryId: req.params?.territoryId,
            error: error.message,
            stack: error.stack
        });
        console.error('[Pixels] Error:', error);
        res.status(500).json({ error: 'Failed to fetch pixel data' });
    }
});

/**
 * POST /api/territories/:territoryId/pixels
 * 영토의 픽셀 데이터 저장 (인증 필요)
 */
// ⚡ 인증 미들웨어를 여기서만 적용 (GET은 공개, POST/DELETE는 인증 필요)
router.post('/', async (req, res, next) => {
    // ⚡ 인증 체크: req.user가 없으면 401 반환
    if (!req.user || !req.user.uid) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    next();
}, async (req, res) => {
    // ⚠️ 진단용: reqId 추출 (프론트에서 x-request-id 또는 x-save-run-id 헤더로 전달)
    const reqId = req.headers['x-request-id'] || req.headers['x-save-run-id'] || `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    try {
        const { territoryId: territoryIdParam } = req.params;
        const { pixels, width, height, isDelta } = req.body;
        const firebaseUid = req.user.uid;
        
        // ⚠️ 진단용: 받은 데이터 상세 로깅
        const payloadPixelsLen = pixels ? (Array.isArray(pixels) ? pixels.length : 0) : 0;
        const contentLength = req.get('content-length') ? parseInt(req.get('content-length')) : 0;
        
        logger.info(`[Pixels] 🔍 POST /pixels START`, {
            reqId,
            territoryIdRaw: territoryIdParam,
            contentLength,
            payloadPixelsLen,
            payloadEncodedLen: 0, // legacy는 encoded 없음
            isDelta: isDelta || false,
            width: width || 0,
            height: height || 0,
            pixelsType: typeof pixels,
            pixelsIsArray: Array.isArray(pixels),
            bodyKeys: Object.keys(req.body)
        });
        
        // ID 검증 및 Canonical ID 변환
        const idValidation = validateTerritoryIdParam(territoryIdParam, {
            strict: false,
            autoConvert: true,
            logWarning: true
        });
        
        if (!idValidation || !idValidation.canonicalId) {
            logger.error(`[Pixels] ❌ Invalid territory ID`, {
                reqId,
                territoryIdRaw: territoryIdParam,
                error: idValidation?.error
            });
            return res.status(400).json({ 
                error: idValidation?.error || 'Invalid territory ID format',
                received: territoryIdParam
            });
        }
        
        const territoryId = idValidation.canonicalId;
        
        // ⚠️ 진단용: 정규화된 ID와 Redis key 로깅
        const pixelCacheKey = `pixel_data:${territoryId}`;
        logger.info(`[Pixels] 🔍 Territory ID normalized`, {
            reqId,
            territoryIdRaw: territoryIdParam,
            territoryIdNormalized: territoryId,
            redisKey: pixelCacheKey,
            wasDisplayId: idValidation.wasDisplayId || false
        });
        
        // 사용자 ID 조회
        const userResult = await query(
            `SELECT id FROM users WHERE firebase_uid = $1`,
            [firebaseUid]
        );
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const userId = userResult.rows[0].id;
        
        // 영토 소유권 확인
        const territoryResult = await query(
            `SELECT ruler_id FROM territories WHERE id = $1`,
            [territoryId]
        );
        
        if (territoryResult.rows.length === 0) {
            return res.status(404).json({ error: 'Territory not found' });
        }
        
        const territory = territoryResult.rows[0];
        if (territory.ruler_id !== userId) {
            return res.status(403).json({ error: 'You do not own this territory' });
        }
        
        // ⚠️ 핵심 안전장치 1: 0픽셀 저장 거부 (데이터 유실 방지)
        // 기존 데이터 확인
        let existingPixelData = null;
        try {
            const existingDataRaw = await redis.get(pixelCacheKey);
            if (existingDataRaw) {
                existingPixelData = typeof existingDataRaw === 'string' ? JSON.parse(existingDataRaw) : existingDataRaw;
            }
        } catch (e) {
            // 파싱 실패는 무시 (기존 데이터 없음으로 처리)
        }
        const existingPixelsLen = existingPixelData?.pixels?.length || 0;
        
        // ⚠️ 조건: 기존 데이터가 있는데 새 payload가 0이면 거부
        if (existingPixelsLen > 0 && payloadPixelsLen === 0) {
            logger.error(`[Pixels] ❌ Refusing to save: existing data has ${existingPixelsLen} pixels but new payload is empty`, {
                reqId,
                territoryId,
                redisKey: pixelCacheKey,
                existingPixelsLen,
                payloadPixelsLen,
                existingRevision: existingPixelData?.revision || 0
            });
            return res.status(409).json({
                error: 'Refusing to overwrite existing pixel data with empty payload',
                message: 'Existing data exists but new payload is empty. This would cause data loss.',
                existingPixelsCount: existingPixelsLen,
                payloadPixelsCount: payloadPixelsLen
            });
        }
        
        // ⚠️ 조건: 기존 데이터도 없고 새 payload도 0이면 거부 (의미 없는 저장)
        if (existingPixelsLen === 0 && payloadPixelsLen === 0) {
            logger.warn(`[Pixels] ⚠️ Refusing to save: both existing and new payload are empty`, {
                reqId,
                territoryId,
                redisKey: pixelCacheKey
            });
            return res.status(400).json({
                error: 'Empty payload',
                message: 'Cannot save empty pixel data'
            });
        }
        
        // ⚠️ 전문가 조언: revision은 항상 단조 증가, 타입 고정 (정수 increment)
        // ⚠️ 최종 피드백: 동시 저장 시 revision 중복 방지를 위해 Redis INCR 사용 (원자적 증가)
        const revisionKey = `pixel_revision:${territoryId}`;
        let newRevision;
        let incomingRevision = existingPixelData?.revision || 0;
        
        try {
            // Redis INCR을 사용하여 원자적 증가 보장 (동시 저장 시에도 안전)
            newRevision = await redis.incr(revisionKey);
            
            // 첫 저장인 경우 (INCR 결과가 1) revisionKey가 없었으므로 1로 시작
            // 이후 저장은 자동으로 2, 3, 4... 로 증가
            if (newRevision === 1) {
                logger.debug(`[Pixels] First revision for ${territoryId}, starting at 1`);
            } else {
                logger.debug(`[Pixels] Revision incremented to ${newRevision} for ${territoryId}`);
            }
        } catch (error) {
            // Redis INCR 실패 시 fallback: 기존 데이터에서 revision 가져오기
            logger.warn(`[Pixels] Redis INCR failed for ${territoryId}, falling back to read-then-increment:`, error.message);
            if (typeof existingPixelData?.revision === 'number' && Number.isInteger(existingPixelData.revision) && existingPixelData.revision > 0) {
                newRevision = existingPixelData.revision + 1;
            } else {
                newRevision = 1;
            }
        }
        
        // ⚠️ 진단용: 저장 직전 최종 데이터 확인
        const finalPixelsLen = pixels ? (Array.isArray(pixels) ? pixels.length : 0) : 0;
        const pixelData = {
            territoryId,
            pixels: pixels || [],
            width: width || 64,
            height: height || 64,
            filledPixels: finalPixelsLen,
            lastUpdated: new Date().toISOString(),
            ownerId: userId,
            // ⚠️ 개선: 캐시 일관성 검증을 위한 메타데이터 추가
            revision: newRevision,
            updatedAt: new Date().toISOString()
        };
        
        // ⚠️ 진단용: 저장 직전 로깅 (payloadPixelsLen과 finalPixelsLen 비교)
        logger.info(`[Pixels] 🔍 Before save`, {
            reqId,
            territoryId,
            redisKey: pixelCacheKey,
            payloadPixelsLen,
            finalPixelsLen,
            finalWidth: pixelData.width,
            finalHeight: pixelData.height,
            revisionToWrite: newRevision,
            incomingRevision,
            isDelta: isDelta || false
        });
        
        // ⚠️ 핵심 안전장치 2: payloadPixelsLen > 0인데 finalPixelsLen이 0으로 바뀌는 경우 감지
        if (payloadPixelsLen > 0 && finalPixelsLen === 0) {
            logger.error(`[Pixels] ❌ CRITICAL: Payload had ${payloadPixelsLen} pixels but final data is empty!`, {
                reqId,
                territoryId,
                redisKey: pixelCacheKey,
                payloadPixelsLen,
                finalPixelsLen,
                pixelsType: typeof pixels,
                pixelsIsArray: Array.isArray(pixels)
            });
            return res.status(500).json({
                error: 'Internal error: pixel data was lost during processing',
                message: 'Payload had pixels but final data is empty. This indicates a server-side bug.'
            });
        }
        
        // Redis에 저장 (메인 저장소 - 무제한 캐시)
        // ⚠️ Redis는 문자열만 저장하므로 JSON.stringify 필요
        await redis.set(pixelCacheKey, JSON.stringify(pixelData));
        
        // ⚠️ 진단용: 저장 직후 검증
        const verifyDataRaw = await redis.get(pixelCacheKey);
        let verifiedPixelsLen = 0;
        if (verifyDataRaw) {
            try {
                const parsed = typeof verifyDataRaw === 'string' ? JSON.parse(verifyDataRaw) : verifyDataRaw;
                verifiedPixelsLen = parsed?.pixels?.length || 0;
            } catch (e) {
                verifiedPixelsLen = 0;
            }
        }
        
        logger.info(`[Pixels] ✅ Save completed`, {
            reqId,
            territoryId,
            redisKey: pixelCacheKey,
            payloadPixelsLen,
            finalPixelsLen,
            verifiedPixelsLen,
            storedRevision: newRevision,
            updatedAt: pixelData.updatedAt
        });
        
        // ⚡ 핵심 수정: 픽셀 데이터가 있는 territory 목록에 추가 (KEYS/SCAN 대신 Set 사용)
        // Upstash Redis는 KEYS 명령을 지원하지 않으므로, Set을 사용하여 목록 관리
        const territoriesSetKey = 'pixels:territories:set';
        try {
            // Set에 territoryId 추가 (중복 자동 제거)
            await redis.sadd(territoriesSetKey, territoryId);
            console.log(`[Pixels] Added ${territoryId} to territories set`);
        } catch (error) {
            // Set 추가 실패는 무시 (로깅만)
            console.warn(`[Pixels] Failed to add ${territoryId} to territories set:`, error.message);
        }
        
        // ⚠️ 디버깅: 저장 후 즉시 확인
        const verifyData = await redis.get(pixelCacheKey);
        console.log(`[Pixels] Verified saved data for ${territoryId}:`, {
            hasData: !!verifyData,
            pixelsLength: verifyData?.pixels?.length || 0,
            filledPixels: verifyData?.filledPixels || 0
        });
        
            // 메타데이터 캐시도 업데이트
            const metaCacheKey = `pixels:${territoryId}`;
            await redis.set(metaCacheKey, pixelData, CACHE_TTL.PIXEL_META);
            
            // 목록 캐시 무효화
            await redis.del('pixels:territories:list');
            
            // WebSocket으로 픽셀 업데이트 브로드캐스트
        broadcastPixelUpdate(territoryId, {
            territoryId,
            pixelCount: pixelData.filledPixels,
            ownerId: userId,
            updatedAt: pixelData.lastUpdated
        });
        
        res.json(pixelData);
    } catch (error) {
        // ⚠️ 에러 상세 로깅 (스택 트레이스 포함)
        logger.error('[Pixels] Error saving pixel data:', {
            error: error.message,
            stack: error.stack,
            territoryId: req.params.territoryId,
            userId: req.user?.uid,
            bodyKeys: Object.keys(req.body || {}),
            pixelsLength: req.body?.pixels?.length || 0
        });
        
        // ⚠️ 개발 환경에서는 더 상세한 에러 정보 제공
        const errorResponse = {
            error: 'Failed to save pixel data',
            message: process.env.NODE_ENV === 'development' ? error.message : undefined,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        };
        
        res.status(500).json(errorResponse);
    }
});

/**
 * DELETE /api/territories/:territoryId/pixels
 * 영토의 픽셀 데이터 삭제 (소유권 이전 시)
 */
// ⚡ 인증 미들웨어를 여기서만 적용 (GET은 공개, DELETE는 인증 필요)
router.delete('/', async (req, res, next) => {
    // ⚡ 인증 체크: req.user가 없으면 401 반환
    if (!req.user || !req.user.uid) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    next();
}, async (req, res) => {
    try {
        const { territoryId: territoryIdParam } = req.params;
        const firebaseUid = req.user.uid;
        
        // ID 검증 및 Canonical ID 변환
        const idValidation = validateTerritoryIdParam(territoryIdParam, {
            strict: false,
            autoConvert: true,
            logWarning: true
        });
        
        if (!idValidation || !idValidation.canonicalId) {
            return res.status(400).json({ 
                error: idValidation?.error || 'Invalid territory ID format',
                received: territoryIdParam
            });
        }
        
        const territoryId = idValidation.canonicalId;
        
        // 사용자 ID 조회
        const userResult = await query(
            `SELECT id FROM users WHERE firebase_uid = $1`,
            [firebaseUid]
        );
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const userId = userResult.rows[0].id;
        
        // 영토 소유권 확인 (소유권 이전 시 이전 소유자 또는 새 소유자가 삭제 가능)
        const territoryResult = await query(
            `SELECT ruler_id FROM territories WHERE id = $1`,
            [territoryId]
        );
        
        if (territoryResult.rows.length === 0) {
            return res.status(404).json({ error: 'Territory not found' });
        }
        
        // Redis에서 픽셀 데이터 삭제
        const pixelCacheKey = `pixel_data:${territoryId}`;
        const metaCacheKey = `pixels:${territoryId}`;
        
        await redis.del(pixelCacheKey);
        await redis.del(metaCacheKey);
        
        // ⚡ 핵심 수정: Set에서도 territoryId 제거
        const territoriesSetKey = 'pixels:territories:set';
        try {
            await redis.srem(territoriesSetKey, territoryId);
            console.log(`[Pixels] Removed ${territoryId} from territories set`);
        } catch (error) {
            console.warn(`[Pixels] Failed to remove ${territoryId} from territories set:`, error.message);
        }
        
        // 목록 캐시 무효화
        await redis.del('pixels:territories:list');
        
        // WebSocket으로 픽셀 삭제 브로드캐스트
        broadcastPixelUpdate(territoryId, {
            territoryId,
            pixelCount: 0,
            ownerId: null,
            updatedAt: new Date().toISOString(),
            deleted: true
        });
        
        res.json({ 
            success: true, 
            message: 'Pixel data deleted',
            territoryId 
        });
    } catch (error) {
        console.error('[Pixels] Delete error:', error);
        res.status(500).json({ error: 'Failed to delete pixel data' });
    }
});

/**
 * GET /api/territories/:territoryId/pixels/metadata
 * 영토 메타데이터만 조회 (가벼움)
 */
router.get('/metadata', async (req, res) => {
    try {
        const { territoryId: territoryIdParam } = req.params;
        
        // ID 검증 및 Canonical ID 변환
        const idValidation = validateTerritoryIdParam(territoryIdParam, {
            strict: false,
            autoConvert: true,
            logWarning: true
        });
        
        if (!idValidation || !idValidation.canonicalId) {
            return res.status(400).json({ 
                error: idValidation?.error || 'Invalid territory ID format',
                received: territoryIdParam
            });
        }
        
        const territoryId = idValidation.canonicalId;
        
        // ⚠️ 운영 안전 정책: metadata는 실패하면 안 되는 API
        // 모든 단계에서 null/undefined/파싱 실패 방어
        
        // 영토 메타데이터 조회 (경량화: 작은 고정 필드만)
        const metaKey = `territory_meta:${territoryId}`;
        let metadata = null;
        
        try {
            const metadataRaw = await redis.get(metaKey);
            // null/undefined 체크 및 JSON 파싱 안전 처리
            if (metadataRaw && typeof metadataRaw === 'string') {
                try {
                    metadata = JSON.parse(metadataRaw);
                } catch (parseError) {
                    console.warn(`[Pixels] Metadata JSON parse failed for ${territoryId}, using defaults`);
                    metadata = null;
                }
            } else if (metadataRaw && typeof metadataRaw === 'object') {
                metadata = metadataRaw;
            }
        } catch (redisError) {
            console.warn(`[Pixels] Redis get failed for ${metaKey}, using defaults:`, redisError.message);
            metadata = null;
        }
        
        // 타일 리비전 맵은 별도 Hash 키로 분리
        const tileRevKey = `territory_tile_rev:${territoryId}`;
        
        // ⚠️ fallback 200을 관측 가능하게 만들기: metaSource 필드 추가
        let metaSource = 'redis'; // 'redis' | 'default' | 'recovered'
        
        if (!metadata || typeof metadata !== 'object') {
            // 메타데이터가 없으면 기본값 생성
            metaSource = 'default';
            let territoryRevision = 0;
            try {
                const territoryRevisionKey = `territory_revision:${territoryId}`;
                const revisionRaw = await redis.get(territoryRevisionKey);
                if (revisionRaw) {
                    territoryRevision = parseInt(revisionRaw) || 0;
                }
            } catch (revisionError) {
                console.warn(`[Pixels] Failed to get territory revision, using 0:`, revisionError.message);
            }
            
            // ⚠️ 경량화: tileRevisionMap은 메타데이터에 포함하지 않음
            metadata = {
                territoryId,
                gridVersion: 2, // 128×128
                territoryRevision: territoryRevision,
                encodingVersion: 1,
                updatedAt: new Date().toISOString(),
                ownerId: null
            };
            
            // ⚠️ DB 실패 시 기본값: ownerId/ruler 쪽은 "절대 throw 금지"
            // 영토 소유자 조회 (안전 처리 - 실패해도 null로 고정)
            try {
                const territoryResult = await query(
                    `SELECT ruler_id FROM territories WHERE id = $1`,
                    [territoryId]
                );
                
                if (territoryResult && territoryResult.rows && territoryResult.rows.length > 0) {
                    metadata.ownerId = territoryResult.rows[0].ruler_id || null;
                }
            } catch (queryError) {
                // DB 오류는 절대 throw하지 않고 null로 고정
                console.warn(`[Pixels] Failed to query territory owner, using null:`, queryError.message);
                metadata.ownerId = null;
            }
            
            // 메타데이터 저장 (실패해도 계속 진행)
            try {
                await redis.set(metaKey, JSON.stringify(metadata));
            } catch (saveError) {
                console.warn(`[Pixels] Failed to save metadata, continuing anyway:`, saveError.message);
            }
        } else {
            // 기존 메타데이터가 있으면 필수 필드 보장
            if (typeof metadata.gridVersion !== 'number') {
                metadata.gridVersion = 2;
                metaSource = 'recovered'; // 필드 복구
            }
            if (typeof metadata.territoryRevision !== 'number') {
                metadata.territoryRevision = 0;
                metaSource = 'recovered';
            }
            if (typeof metadata.encodingVersion !== 'number') {
                metadata.encodingVersion = 1;
                metaSource = 'recovered';
            }
            if (!metadata.updatedAt) {
                metadata.updatedAt = new Date().toISOString();
                metaSource = 'recovered';
            }
            if (!metadata.territoryId) {
                metadata.territoryId = territoryId;
                metaSource = 'recovered';
            }
        }
        
        // ⚠️ tileRevisionMap 타입 정규화 및 검증 강화
        // 키 포맷 검증: territoryId:tileX:tileY
        // tileX/tileY 범위 검증: 0~7 (128/16 = 8)
        // revision 타입 정규화: 반드시 number로 변환
        let normalizedTileRevisionMap = {};
        try {
            const tileRevisionMap = await redis.hgetall(tileRevKey);
            if (tileRevisionMap && typeof tileRevisionMap === 'object') {
                const expectedPrefix = `${territoryId}:`;
                const maxTileIndex = 7; // tilesX - 1 = 8 - 1 = 7
                
                for (const [tileId, rev] of Object.entries(tileRevisionMap)) {
                    if (!tileId || rev === null || rev === undefined) continue;
                    
                    // 키 포맷 검증: territoryId로 시작하는지
                    if (!tileId.startsWith(expectedPrefix)) {
                        console.warn(`[Pixels] Invalid tile key format: ${tileId}, skipping`);
                        continue;
                    }
                    
                    // tileX/tileY 추출 및 범위 검증
                    const parts = tileId.split(':');
                    if (parts.length !== 3) {
                        console.warn(`[Pixels] Invalid tile key format (expected 3 parts): ${tileId}, skipping`);
                        continue;
                    }
                    
                    const tileX = parseInt(parts[1]);
                    const tileY = parseInt(parts[2]);
                    
                    // 범위 검증: 0~7
                    if (isNaN(tileX) || isNaN(tileY) || 
                        tileX < 0 || tileX > maxTileIndex || 
                        tileY < 0 || tileY > maxTileIndex) {
                        console.warn(`[Pixels] Tile index out of range: ${tileId} (${tileX}, ${tileY}), skipping`);
                        continue;
                    }
                    
                    // revision 타입 정규화: 반드시 number로 변환
                    const revision = parseInt(rev);
                    if (isNaN(revision) || revision < 0) {
                        normalizedTileRevisionMap[tileId] = 0;
                    } else {
                        normalizedTileRevisionMap[tileId] = revision;
                    }
                }
            }
        } catch (tileRevError) {
            console.warn(`[Pixels] Failed to get tile revision map, using empty:`, tileRevError.message);
            normalizedTileRevisionMap = {};
        }
        
        // 응답에 타일 리비전 맵 및 metaSource 포함
        // metaSource는 로그/모니터링용 (클라이언트 UI에는 표시 안 함)
        res.json({
            ...metadata,
            tileRevisionMap: normalizedTileRevisionMap,
            metaSource // 'redis' | 'default' | 'recovered'
        });
    } catch (error) {
        // ⚠️ 운영 안전 정책: metadata는 실패하면 안 되는 API
        // 예외가 나도 기본 메타데이터를 반환하여 항상 200 응답
        console.error('[Pixels] Metadata error:', error);
        console.error('[Pixels] Metadata error stack:', error.stack);
        
        const { territoryId: territoryIdParam } = req.params;
        const idValidation = validateTerritoryIdParam(territoryIdParam, {
            strict: false,
            autoConvert: true,
            logWarning: false // 에러 상황에서는 경고 로그 생략
        });
        
        const territoryId = idValidation?.canonicalId || territoryIdParam;
        
        // ⚠️ DB 실패 시 기본값: ownerId는 절대 throw 금지
        let ownerId = null;
        try {
            const territoryResult = await query(
                `SELECT ruler_id FROM territories WHERE id = $1`,
                [territoryId]
            );
            if (territoryResult && territoryResult.rows && territoryResult.rows.length > 0) {
                ownerId = territoryResult.rows[0].ruler_id || null;
            }
        } catch (queryError) {
            // DB 오류는 절대 throw하지 않고 null로 고정
            console.warn(`[Pixels] Failed to query territory owner in catch block, using null:`, queryError.message);
            ownerId = null;
        }
        
        // 기본 메타데이터 반환 (항상 200)
        // ⚠️ fallback 200을 관측 가능하게 만들기: metaSource 필드 추가
        const defaultMetadata = {
            territoryId,
            gridVersion: 2, // 128×128
            territoryRevision: 0,
            encodingVersion: 1,
            tileRevisionMap: {},
            updatedAt: new Date().toISOString(),
            ownerId: ownerId,
            metaSource: 'default' // fallback 200 관측용 ('redis' | 'default' | 'recovered')
        };
        
        // 내부 오류 로그는 남기되, 클라이언트에는 기본 메타 반환
        res.status(200).json(defaultMetadata);
    }
});

/**
 * GET /api/territories/:territoryId/pixels/tiles
 * 필요한 타일만 조회 (클라이언트 리비전 비교 후 요청)
 */
router.get('/tiles', async (req, res) => {
    try {
        const { territoryId: territoryIdParam } = req.params;
        const { tiles, revisions } = req.query; // tiles: "tile1,tile2", revisions: JSON string
        
        // ID 검증 및 Canonical ID 변환
        const idValidation = validateTerritoryIdParam(territoryIdParam, {
            strict: false,
            autoConvert: true,
            logWarning: true
        });
        
        if (!idValidation || !idValidation.canonicalId) {
            return res.status(400).json({ 
                error: idValidation?.error || 'Invalid territory ID format',
                received: territoryIdParam
            });
        }
        
        const territoryId = idValidation.canonicalId;
        
        // 요청된 타일 목록 파싱
        const requestedTiles = tiles ? tiles.split(',') : [];
        let clientRevisions = {};
        
        if (revisions) {
            try {
                clientRevisions = JSON.parse(revisions);
            } catch (e) {
                console.warn('[Pixels] Failed to parse revisions:', e);
            }
        }
        
        const tilesData = [];
        const unchanged = [];
        
        // 각 타일 조회
        for (const tileId of requestedTiles) {
            const tileKey = `tile_data:${tileId}`;
            const tileData = await redis.get(tileKey);
            
            if (!tileData) {
                // 타일이 없으면 건너뛰기
                continue;
            }
            
            const clientRevision = clientRevisions[tileId] || 0;
            const serverRevision = tileData.revision || 0;
            
            if (clientRevision === serverRevision) {
                // 리비전이 동일하면 변경 없음
                unchanged.push(tileId);
            } else {
                // 리비전이 다르면 타일 데이터 반환
                tilesData.push({
                    tileId: tileData.tileId || tileId,
                    revision: serverRevision,
                    pixels: tileData.pixels || [],
                    updatedAt: tileData.updatedAt || new Date().toISOString()
                });
            }
        }
        
        res.json({
            tiles: tilesData,
            unchanged
        });
    } catch (error) {
        console.error('[Pixels] Tiles error:', error);
        res.status(500).json({ error: 'Failed to fetch tiles' });
    }
});

/**
 * POST /api/territories/:territoryId/pixels/tiles
 * 변경된 타일만 저장 (dirty tiles)
 */
router.post('/tiles', async (req, res, next) => {
    // 인증 체크
    if (!req.user || !req.user.uid) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    next();
}, async (req, res) => {
    // ⚠️ 진단용: reqId 추출
    const reqId = req.headers['x-request-id'] || req.headers['x-save-run-id'] || `tiles-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    try {
        const { territoryId: territoryIdParam } = req.params;
        const { tiles } = req.body; // Array<{tileId, pixels, revision}>
        const firebaseUid = req.user.uid;
        
        // ⚠️ 진단용: 받은 데이터 상세 로깅
        const tilesCount = Array.isArray(tiles) ? tiles.length : 0;
        const contentLength = req.get('content-length') ? parseInt(req.get('content-length')) : 0;
        const bodyKeys = Object.keys(req.body || {});
        
        logger.info(`[Pixels] 🔍 POST /tiles START`, {
            reqId,
            territoryIdRaw: territoryIdParam,
            contentLength,
            tilesCount,
            bodyKeys,
            tilesType: typeof tiles,
            tilesIsArray: Array.isArray(tiles),
            tilesSample: Array.isArray(tiles) && tiles.length > 0 ? tiles[0] : null
        });
        
        // ID 검증 및 Canonical ID 변환
        const idValidation = validateTerritoryIdParam(territoryIdParam, {
            strict: false,
            autoConvert: true,
            logWarning: true
        });
        
        if (!idValidation || !idValidation.canonicalId) {
            return res.status(400).json({ 
                error: idValidation?.error || 'Invalid territory ID format',
                received: territoryIdParam
            });
        }
        
        const territoryId = idValidation.canonicalId;
        
        // 사용자 ID 조회
        const userResult = await query(
            `SELECT id FROM users WHERE firebase_uid = $1`,
            [firebaseUid]
        );
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const userId = userResult.rows[0].id;
        
        // 영토 소유권 확인
        const territoryResult = await query(
            `SELECT ruler_id FROM territories WHERE id = $1`,
            [territoryId]
        );
        
        if (territoryResult.rows.length === 0) {
            return res.status(404).json({ error: 'Territory not found' });
        }
        
        const territory = territoryResult.rows[0];
        if (territory.ruler_id !== userId) {
            return res.status(403).json({ error: 'You do not own this territory' });
        }
        
        // 영토 메타데이터 조회/생성 (경량화)
        const metaKey = `territory_meta:${territoryId}`;
        let metadataRaw = await redis.get(metaKey);
        let metadata;
        
        if (!metadataRaw) {
            metadata = {
                territoryId,
                gridVersion: 2,
                territoryRevision: 0,
                updatedAt: new Date().toISOString(),
                ownerId: userId
            };
        } else {
            // Redis에서 가져온 데이터는 JSON 문자열이므로 파싱 필요
            try {
                metadata = typeof metadataRaw === 'string' ? JSON.parse(metadataRaw) : metadataRaw;
            } catch (parseError) {
                logger.warn(`[Pixels] Failed to parse metadata for ${territoryId}, using defaults:`, parseError.message);
                metadata = {
                    territoryId,
                    gridVersion: 2,
                    territoryRevision: 0,
                    updatedAt: new Date().toISOString(),
                    ownerId: userId
                };
            }
        }
        
        // 영토 리비전 증가
        const territoryRevisionKey = `territory_revision:${territoryId}`;
        const newTerritoryRevision = await redis.incr(territoryRevisionKey);
        metadata.territoryRevision = newTerritoryRevision;
        
        // 타일 리비전 맵은 별도 Hash 키로 관리
        const tileRevKey = `territory_tile_rev:${territoryId}`;
        
        // ⚠️ CRITICAL: 기존 타일 리비전 맵에 잘못된 형식의 키가 있는지 확인 및 정리
        // Upstash SDK 버그로 인해 숫자 문자열("0", "1", ...)이 키로 저장된 경우 정리
        try {
            const existingTileRevMap = await redis.hgetall(tileRevKey);
            if (existingTileRevMap && typeof existingTileRevMap === 'object') {
                const existingKeys = Object.keys(existingTileRevMap);
                const invalidKeys = existingKeys.filter(key => {
                    // 타일 ID 형식 검증: territoryId:tileX:tileY 형식이어야 함
                    const parts = String(key).split(':');
                    return parts.length !== 3 || parts[0] !== territoryId || 
                           isNaN(parseInt(parts[1])) || isNaN(parseInt(parts[2]));
                });
                
                if (invalidKeys.length > 0) {
                    logger.warn(`[Pixels][POST] ⚠️ Found ${invalidKeys.length} invalid keys in tile revision map, cleaning up`, {
                        reqId,
                        territoryId,
                        tileRevKey,
                        invalidKeys: invalidKeys.slice(0, 10), // 처음 10개만 로그
                        totalKeys: existingKeys.length
                    });
                    
                    // 잘못된 키 삭제
                    for (const invalidKey of invalidKeys) {
                        try {
                            await redis.hdel(tileRevKey, invalidKey);
                            logger.debug(`[Pixels][POST] ✅ Removed invalid key from tile revision map`, {
                                reqId,
                                territoryId,
                                invalidKey
                            });
                        } catch (hdelError) {
                            logger.warn(`[Pixels][POST] ⚠️ Failed to remove invalid key`, {
                                reqId,
                                territoryId,
                                invalidKey,
                                error: hdelError.message
                            });
                        }
                    }
                }
            }
        } catch (cleanupError) {
            // 정리 실패는 치명적이지 않으므로 로그만 남기고 계속 진행
            logger.warn(`[Pixels][POST] ⚠️ Failed to cleanup invalid tile revision map keys (non-critical)`, {
                reqId,
                territoryId,
                error: cleanupError.message
            });
        }
        
        const updatedTiles = [];
        const conflicts = [];
        
        // 각 타일 처리 (CAS 방식)
        for (const tile of tiles) {
            const { tileId, pixels, revision: clientRevision } = tile;
            
            // ⚠️ CRITICAL: tileId 검증 - 타일 ID가 올바른 형식인지 확인
            if (!tileId || typeof tileId !== 'string') {
                logger.error(`[Pixels][POST] ❌ Invalid tileId in request`, {
                    reqId,
                    territoryId,
                    tileId,
                    tileIdType: typeof tileId,
                    tile: tile
                });
                conflicts.push({
                    tileId: tileId || 'INVALID',
                    clientRevision: clientRevision || 0,
                    serverRevision: 0,
                    message: `Invalid tileId format: expected string, got ${typeof tileId}`
                });
                continue;
            }
            
            // ⚠️ 타일 ID 형식 검증: territoryId:tileX:tileY 형식이어야 함
            const tileIdParts = tileId.split(':');
            if (tileIdParts.length !== 3 || tileIdParts[0] !== territoryId) {
                logger.error(`[Pixels][POST] ❌ Invalid tileId format`, {
                    reqId,
                    territoryId,
                    tileId,
                    tileIdParts,
                    expectedFormat: `${territoryId}:tileX:tileY`
                });
                conflicts.push({
                    tileId,
                    clientRevision: clientRevision || 0,
                    serverRevision: 0,
                    message: `Invalid tileId format: expected ${territoryId}:tileX:tileY, got ${tileId}`
                });
                continue;
            }
            
            logger.debug(`[Pixels][POST] 🔍 Processing tile`, {
                reqId,
                territoryId,
                tileId,
                tileIdType: typeof tileId,
                tileIdParts,
                pixelsCount: pixels?.length || 0
            });
            
            // ⚠️ CAS: Compare-And-Set 방식으로 충돌 감지
            const tileRevisionKey = `tile_revision:${tileId}`;
            const currentRevisionRaw = await redis.get(tileRevisionKey);
            const currentRevision = parseInt(currentRevisionRaw || 0);
            
            // ⚠️ 디버깅: 모든 타일의 revision 상태 로깅
            logger.warn(`[Pixels][POST] 🔍 Tile revision check`, {
                reqId,
                territoryId,
                tileId,
                clientRevision,
                clientRevisionType: typeof clientRevision,
                currentRevision,
                currentRevisionRaw,
                currentRevisionType: typeof currentRevisionRaw,
                pixelsCount: pixels?.length || 0
            });
            
            // ⚠️ 개선: revision이 0이거나 undefined면 첫 저장으로 간주 (항상 허용)
            // 클라이언트가 baseRevision을 보냈는데 서버와 다르면 충돌
            // 단, clientRevision이 0이거나 undefined면 첫 저장으로 간주하여 허용
            const isFirstSave = clientRevision === undefined || 
                               clientRevision === 0 || 
                               clientRevision === null ||
                               clientRevision === '0' ||
                               String(clientRevision) === '0';
            
            // ⚠️ revision 비교 (문자열/숫자 모두 처리)
            const clientRevNum = parseInt(clientRevision) || 0;
            const serverRevNum = parseInt(currentRevision) || 0;
            const revisionMatch = clientRevNum === serverRevNum;
            
            // ⚠️ 개선: revision 비교 로직
            // 1. 첫 저장 (isFirstSave)이면 항상 허용
            // 2. revision이 일치하면 허용
            // 3. 클라이언트 revision이 0이고 서버에 데이터가 있으면 충돌 (클라이언트가 오래된 데이터를 가지고 있음)
            // 4. 클라이언트 revision이 서버보다 작으면 허용 (낙관적 동시성 제어)
            // 5. 클라이언트 revision이 서버보다 크면 거부 (데이터 손실 방지)
            
            let canProceed = false;
            let conflictReason = '';
            
            if (isFirstSave) {
                canProceed = true;
            } else if (revisionMatch) {
                canProceed = true;
            } else if (clientRevNum === 0 && serverRevNum > 0) {
                // 클라이언트가 revision 0을 보냈는데 서버에 이미 데이터가 있으면 충돌
                canProceed = false;
                conflictReason = 'client_revision_zero_but_server_has_data';
            } else if (clientRevNum < serverRevNum) {
                // 클라이언트 revision이 서버보다 작으면 허용 (낙관적 동시성 제어)
                canProceed = true;
            } else if (clientRevNum > serverRevNum) {
                // 클라이언트 revision이 서버보다 크면 거부
                canProceed = false;
                conflictReason = 'client_revision_too_high';
            } else {
                canProceed = false;
                conflictReason = 'revision_mismatch';
            }
            
            logger.warn(`[Pixels][POST] 🔍 Revision comparison`, {
                reqId,
                territoryId,
                tileId,
                isFirstSave,
                clientRevNum,
                serverRevNum,
                revisionMatch,
                canProceed,
                conflictReason
            });
            
            if (!canProceed) {
                // 충돌 발생
                logger.warn(`[Pixels][POST] ⚠️ Revision conflict for tile ${tileId}`, {
                    reqId,
                    territoryId,
                    tileId,
                    clientRevision,
                    clientRevNum,
                    serverRevision: currentRevision,
                    serverRevNum,
                    isFirstSave,
                    revisionMatch,
                    conflictReason
                });
                conflicts.push({
                    tileId,
                    clientRevision: clientRevNum,
                    serverRevision: serverRevNum,
                    message: 'Tile revision conflict. Client must re-sync before saving.'
                });
                continue;
            }
            
            // ⚠️ 첫 저장이거나 revision이 일치하면 진행
            if (isFirstSave) {
                logger.warn(`[Pixels][POST] ✅ First save for tile ${tileId}`, {
                    reqId,
                    territoryId,
                    tileId,
                    clientRevision,
                    currentRevision
                });
            } else {
                logger.warn(`[Pixels][POST] ✅ Revision match for tile ${tileId}`, {
                    reqId,
                    territoryId,
                    tileId,
                    clientRevision: clientRevNum,
                    serverRevision: serverRevNum
                });
            }
            
            // 타일 리비전 증가 (원자적 연산)
            const newRevision = await redis.incr(tileRevisionKey);
            
            // ⚠️ 타일 데이터 저장: compressed 기본값 true (압축 payload)
            const tileData = {
                tileId,
                territoryId,
                pixels: pixels || [],
                revision: newRevision,
                updatedAt: new Date().toISOString(),
                compressed: true // 기본값: 압축된 payload
            };
            
            // 타일 좌표 추출 (tileId에서)
            const parts = tileId.split(':');
            if (parts.length === 3) {
                tileData.tileX = parseInt(parts[1]);
                tileData.tileY = parseInt(parts[2]);
            }
            
            const tileKey = `tile_data:${tileId}`;
            // ⚠️ redis.set()은 내부에서 JSON.stringify를 처리하므로 객체를 직접 전달
            try {
                await redis.set(tileKey, tileData);
                logger.debug(`[Pixels][POST] ✅ Tile data saved to Redis`, {
                    reqId,
                    territoryId,
                    tileId,
                    tileKey,
                    pixelsCount: pixels?.length || 0
                });
            } catch (setError) {
                logger.error(`[Pixels][POST] ❌ Failed to save tile data to Redis`, {
                    reqId,
                    territoryId,
                    tileId,
                    tileKey,
                    error: setError.message,
                    stack: setError.stack
                });
                throw setError; // 타일 저장 실패는 치명적이므로 throw
            }
            
            // ⚠️ 타일 리비전 맵은 별도 Hash로 업데이트 (메타데이터와 분리)
            // ⚠️ CRITICAL: tileId가 문자열인지 다시 한 번 확인 (Redis hset에 전달 전)
            if (typeof tileId !== 'string' || !tileId.includes(':')) {
                logger.error(`[Pixels][POST] ❌ CRITICAL: tileId is not a valid string before hset`, {
                    reqId,
                    territoryId,
                    tileId,
                    tileIdType: typeof tileId,
                    tileIdValue: String(tileId),
                    tileIdStringified: JSON.stringify(tileId)
                });
                throw new Error(`Invalid tileId before hset: ${tileId} (type: ${typeof tileId})`);
            }
            
            try {
                // ⚠️ 명시적으로 문자열로 변환하여 전달 (이중 안전장치)
                const tileIdString = String(tileId);
                const revisionString = String(newRevision);
                
                logger.debug(`[Pixels][POST] 🔍 About to call hset`, {
                    reqId,
                    territoryId,
                    tileRevKey,
                    tileId: tileIdString,
                    tileIdType: typeof tileIdString,
                    revision: revisionString,
                    revisionType: typeof revisionString
                });
                
                const hsetResult = await redis.hset(tileRevKey, tileIdString, revisionString);
                
                logger.warn(`[Pixels][POST] ✅ Tile revision map updated`, {
                    reqId,
                    territoryId,
                    tileId: tileIdString,
                    tileRevKey,
                    revision: revisionString,
                    hsetResult,
                    hsetResultType: typeof hsetResult
                });
                
                // ⚠️ 저장 직후 검증: hget으로 확인
                try {
                    const verifyValue = await redis.hget(tileRevKey, tileIdString);
                    if (verifyValue !== revisionString) {
                        logger.error(`[Pixels][POST] ❌ CRITICAL: hset verification failed`, {
                            reqId,
                            territoryId,
                            tileId: tileIdString,
                            tileRevKey,
                            expectedRevision: revisionString,
                            actualRevision: verifyValue,
                            verifyValueType: typeof verifyValue
                        });
                    } else {
                        logger.debug(`[Pixels][POST] ✅ hset verification passed`, {
                            reqId,
                            territoryId,
                            tileId: tileIdString,
                            revision: revisionString
                        });
                    }
                } catch (verifyError) {
                    logger.warn(`[Pixels][POST] ⚠️ Failed to verify hset (non-critical)`, {
                        reqId,
                        territoryId,
                        tileId: tileIdString,
                        error: verifyError.message
                    });
                }
            } catch (hsetError) {
                logger.error(`[Pixels][POST] ❌ Failed to update tile revision map`, {
                    reqId,
                    territoryId,
                    tileId,
                    tileIdType: typeof tileId,
                    tileRevKey,
                    revision: newRevision,
                    error: hsetError.message,
                    stack: hsetError.stack
                });
                // 타일 리비전 맵 업데이트 실패는 치명적이므로 throw
                throw hsetError;
            }
            
            logger.info(`[Pixels] ✅ Tile saved`, {
                reqId,
                territoryId,
                tileId,
                revision: newRevision,
                pixelsCount: pixels?.length || 0
            });
            
            updatedTiles.push({
                tileId,
                revision: newRevision,
                updatedAt: tileData.updatedAt
            });
        }
        
        // ⚠️ 저장 후 검증: 타일 리비전 맵이 실제로 저장되었는지 확인
        let finalTileRevisionMap;
        try {
            finalTileRevisionMap = await redis.hgetall(tileRevKey);
        } catch (verifyError) {
            logger.error(`[Pixels][POST] ❌ Failed to verify tile revision map`, {
                reqId,
                territoryId,
                tileRevKey,
                error: verifyError.message
            });
            finalTileRevisionMap = {};
        }
        
        if (!finalTileRevisionMap || typeof finalTileRevisionMap !== 'object') {
            finalTileRevisionMap = {};
        }
        
        const finalTileCount = Object.keys(finalTileRevisionMap).length;
        const savedTileIds = updatedTiles.map(t => t.tileId);
        const missingTiles = savedTileIds.filter(tileId => !finalTileRevisionMap[tileId]);
        
        // ⚠️ 각 타일 데이터가 실제로 Redis에 저장되었는지 확인
        const tileVerificationResults = [];
        for (const updatedTile of updatedTiles) {
            const tileKey = `tile_data:${updatedTile.tileId}`;
            try {
                const exists = await redis.exists(tileKey);
                tileVerificationResults.push({
                    tileId: updatedTile.tileId,
                    tileKey,
                    exists: exists === true || exists === 1
                });
            } catch (verifyError) {
                tileVerificationResults.push({
                    tileId: updatedTile.tileId,
                    tileKey,
                    exists: false,
                    error: verifyError.message
                });
            }
        }
        
        const tilesNotInRedis = tileVerificationResults.filter(r => !r.exists);
        
        logger.warn(`[Pixels][POST] 📊 Final tile revision map after save`, {
            reqId,
            territoryId,
            tileRevKey,
            tileCount: finalTileCount,
            expectedTileCount: tiles.length,
            savedTileCount: updatedTiles.length,
            tileIds: Object.keys(finalTileRevisionMap),
            savedTiles: savedTileIds,
            missingTiles: missingTiles,
            match: finalTileCount === updatedTiles.length,
            tileVerificationResults: tileVerificationResults,
            tilesNotInRedis: tilesNotInRedis.map(t => t.tileId)
        });
        
        // ⚠️ 저장 검증: 저장한 타일 수와 실제 Redis에 있는 타일 수가 일치하는지 확인
        if (finalTileCount === 0 && tiles.length > 0) {
            logger.error(`[Pixels][POST] ❌ CRITICAL: Tiles saved but tile revision map is empty!`, {
                reqId,
                territoryId,
                tilesSaved: tiles.length,
                tileRevMapCount: finalTileCount,
                tileRevKey
            });
        } else if (finalTileCount < tiles.length) {
            logger.warn(`[Pixels][POST] ⚠️ WARNING: Some tiles may not have been saved`, {
                reqId,
                territoryId,
                tilesSaved: tiles.length,
                tileRevMapCount: finalTileCount,
                missing: tiles.length - finalTileCount
            });
        }
        
        // 영토 메타데이터 업데이트 (경량화: tileRevisionMap 제외)
        metadata.updatedAt = new Date().toISOString();
        // ⚠️ redis.set()은 내부에서 JSON.stringify를 처리하므로 객체를 직접 전달
        await redis.set(metaKey, metadata);
        
        // 영토 목록 Set에 추가
        const territoriesSetKey = 'pixels:territories:set';
        await redis.sadd(territoriesSetKey, territoryId);
        
        // 목록 캐시 무효화
        await redis.del('pixels:territories:list');
        
        // ⚠️ 핵심 수정: pixel_data 캐시 무효화 (타일 저장 시 전체 픽셀 데이터 캐시 삭제)
        // 다음 GET 요청 시 타일을 다시 조합하여 최신 데이터 반환
        const pixelCacheKey = `pixel_data:${territoryId}`;
        await redis.del(pixelCacheKey);
        
        // 레거시 캐시도 무효화
        const legacyCacheKey = `pixels:${territoryId}`;
        await redis.del(legacyCacheKey);
        
        // WebSocket으로 타일 업데이트 브로드캐스트
        broadcastPixelUpdate(territoryId, {
            type: 'PIXEL_TILES_UPDATED',
            territoryId,
            territoryRevision: newTerritoryRevision,
            updatedTiles
        });
        
        // 충돌이 있으면 409 Conflict 반환
        if (conflicts.length > 0) {
            logger.warn(`[Pixels][POST] ❌ Returning 409 Conflict`, {
                reqId,
                territoryId,
                conflictsCount: conflicts.length,
                conflicts: conflicts.map(c => ({ tileId: c.tileId, clientRev: c.clientRevision, serverRev: c.serverRevision })),
                updatedTilesCount: updatedTiles.length,
                updatedTiles: updatedTiles.map(t => ({ tileId: t.tileId, revision: t.revision }))
            });
            return res.status(409).json({
                success: false,
                error: 'Revision conflicts detected',
                conflicts,
                updatedTiles,
                territoryRevision: newTerritoryRevision,
                message: 'Some tiles had revision conflicts. Please re-sync and retry.'
            });
        }
        
        res.json({
            success: true,
            updatedTiles,
            conflicts,
            territoryRevision: newTerritoryRevision
        });
    } catch (error) {
        // ⚠️ 핵심: 서버 콘솔에 상세 에러 로깅 (가장 중요)
        const territoryId = req.params?.territoryId || 'unknown';
        const bodyKeys = Object.keys(req.body || {});
        const tilesCount = req.body?.tiles ? (Array.isArray(req.body.tiles) ? req.body.tiles.length : 0) : 0;
        
        console.error('[Pixels] ❌ TILES SAVE FAILED', {
            reqId,
            territoryId,
            territoryIdRaw: req.params?.territoryId,
            bodyKeys,
            tilesCount,
            userId: req.user?.uid,
            errorMessage: error.message,
            errorStack: error.stack,
            errorName: error.name,
            errorType: typeof error,
            errorKeys: Object.keys(error || {})
        });
        
        logger.error('[Pixels] ❌ Tiles save error (detailed):', {
            reqId,
            territoryId,
            bodyKeys,
            tilesCount,
            userId: req.user?.uid,
            error: error.message,
            stack: error.stack,
            name: error.name,
            cause: error.cause
        });
        
        // ⚠️ 에러 타입별 상태 코드 분리
        let statusCode = 500;
        let errorMessage = 'Failed to save tiles';
        
        // Validation 에러 (400)
        if (error.message && (
            error.message.includes('Invalid') ||
            error.message.includes('missing') ||
            error.message.includes('required') ||
            error.message.includes('format')
        )) {
            statusCode = 400;
            errorMessage = error.message || 'Invalid request data';
        }
        // 권한 에러 (401/403)
        else if (error.message && (
            error.message.includes('Authentication') ||
            error.message.includes('Permission') ||
            error.message.includes('not own')
        )) {
            statusCode = error.message.includes('Authentication') ? 401 : 403;
            errorMessage = error.message;
        }
        // 기타 서버 에러 (500)
        else {
            statusCode = 500;
            errorMessage = error.message || 'Internal server error';
        }
        
        // ⚠️ 개발 환경에서는 더 상세한 에러 정보 제공
        const errorResponse = {
            error: errorMessage,
            message: process.env.NODE_ENV === 'development' ? error.message : undefined,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
            reqId: process.env.NODE_ENV === 'development' ? reqId : undefined
        };
        
        res.status(statusCode).json(errorResponse);
    }
});

export { router as pixelsRouter, topLevelRouter as pixelsTopLevelRouter };
