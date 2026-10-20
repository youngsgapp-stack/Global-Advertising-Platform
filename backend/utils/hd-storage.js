/**
 * HD 사진 저장소
 * - 기본: PostgreSQL(territory_hd_images)에 저장하고 /api/hd/territories/:id/image 로 제공
 * - HD_STORAGE=firebase: Firebase Storage(FIREBASE_STORAGE_BUCKET, 기본 worldad-8be07.firebasestorage.app)에 저장
 *   (Firebase 콘솔에서 Storage를 켠 뒤 Railway 변수만 바꾸면 전환됨. 기존 DB 사진은 다시 올릴 때 옮겨짐)
 */

import crypto from 'crypto';
import { query } from '../db/init.js';

const FIREBASE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || 'worldad-8be07.firebasestorage.app';
const EXTENSIONS = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg' };

export const DB_IMAGE_MARKER = 'db';

function useFirebase() {
    return process.env.HD_STORAGE === 'firebase';
}

async function getBucket() {
    const { getFirebaseAdmin } = await import('../middleware/auth.js');
    const { admin } = await getFirebaseAdmin();
    return admin.storage().bucket(FIREBASE_BUCKET);
}

/** 파일 앞부분으로 실제 이미지 형식 확인 (SVG 등 스크립트가 들어갈 수 있는 형식 차단) */
export function detectImageType(buffer) {
    if (!buffer || buffer.length < 12) return null;
    if (buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG') return 'image/png';
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return null;
}

/**
 * @returns {Promise<string>} territories.hd_image_url 에 저장할 값 (Firebase는 전체 URL, DB는 'db')
 */
export async function saveHdImage(territoryId, buffer, contentType) {
    if (useFirebase()) {
        const bucket = await getBucket();
        const path = `hd/${territoryId}.${EXTENSIONS[contentType]}`;
        const token = crypto.randomUUID();
        await bucket.file(path).save(buffer, {
            contentType,
            resumable: false,
            metadata: {
                cacheControl: 'public, max-age=31536000',
                metadata: { firebaseStorageDownloadTokens: token }
            }
        });
        await query(`DELETE FROM territory_hd_images WHERE territory_id = $1`, [territoryId]);
        return `https://firebasestorage.googleapis.com/v0/b/${FIREBASE_BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
    }
    await query(
        `INSERT INTO territory_hd_images (territory_id, content_type, data, updated_at) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (territory_id) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, updated_at = NOW()`,
        [territoryId, contentType, buffer]
    );
    return DB_IMAGE_MARKER;
}

function firebasePath(storedUrl) {
    if (!storedUrl || storedUrl === DB_IMAGE_MARKER || !storedUrl.includes('/o/')) return null;
    return decodeURIComponent(storedUrl.split('/o/')[1].split('?')[0]);
}

async function deleteFirebaseObject(path) {
    if (!path) return;
    try {
        const bucket = await getBucket();
        await bucket.file(path).delete({ ignoreNotFound: true });
    } catch (error) {
        console.warn('[HD] Failed to delete Firebase image:', error.message);
    }
}

export async function deleteHdImage(territoryId, storedUrl) {
    await query(`DELETE FROM territory_hd_images WHERE territory_id = $1`, [territoryId]);
    await deleteFirebaseObject(firebasePath(storedUrl));
}

/** 새 사진으로 바꾼 뒤, 다른 위치에 남은 예전 Firebase 파일 정리 (같은 경로면 덮어썼으므로 그대로 둠) */
export async function cleanupReplacedHdImage(previousUrl, newUrl) {
    const previousPath = firebasePath(previousUrl);
    if (previousPath && previousPath !== firebasePath(newUrl)) {
        await deleteFirebaseObject(previousPath);
    }
}

/** 화면에서 쓸 이미지 주소 */
export function publicHdImageUrl(req, territoryId, storedUrl, updatedAt) {
    if (!storedUrl) return null;
    if (storedUrl !== DB_IMAGE_MARKER) return storedUrl;
    const version = updatedAt ? new Date(updatedAt).getTime() : 0;
    return `${req.protocol}://${req.get('host')}/api/hd/territories/${encodeURIComponent(territoryId)}/image?v=${version}`;
}
