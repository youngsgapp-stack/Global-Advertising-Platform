/**
 * 국가 간 이름이 겹치는 행정구역에 대해 국가별 territory 행 생성
 *
 * js/data/territory-id-collisions.js 규칙에 따라 'amazonas-ven' 같은 새 ID의 행을 추가한다.
 * 기존 행(유지 국가)은 변경하지 않는다.
 *
 * 실행 방법:
 *   node scripts/create-collision-territories.js            (미리보기, DB 변경 없음)
 *   node scripts/create-collision-territories.js --apply    (실제 추가)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { query, initDatabase } from '../db/init.js';

dotenv.config();

const NATURAL_EARTH_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COLLISIONS_FILE = path.resolve(__dirname, '../../js/data/territory-id-collisions.js');

// js/core/MapController.js normalizeTerritoryId()와 동일
function slugify(name) {
    return String(name)
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

function loadCollisionKeepers() {
    const source = fs.readFileSync(COLLISIONS_FILE, 'utf8');
    const keepers = {};
    for (const match of source.matchAll(/'([^']+)':\s*'([A-Z]{3})'/g)) {
        keepers[match[1]] = match[2];
    }
    return keepers;
}

async function main() {
    const apply = process.argv.includes('--apply');
    console.log(`[Collisions] ${apply ? 'APPLY' : 'DRY RUN (no changes)'}`);
    
    const keepers = loadCollisionKeepers();
    console.log(`[Collisions] Loaded ${Object.keys(keepers).length} colliding names`);
    
    console.log('[Collisions] Downloading Natural Earth admin-1 data...');
    const geo = await (await fetch(NATURAL_EARTH_URL)).json();
    
    // 새로 필요한 행: 유지 국가가 아닌 feature
    const planned = new Map();
    geo.features.forEach((feature, index) => {
        const props = feature.properties || {};
        const name = props.name || props.name_en || `Region ${index}`;
        const baseId = slugify(name);
        const keeper = keepers[baseId];
        const iso = String(props.adm0_a3 || '').toUpperCase();
        if (!keeper || !iso || iso === keeper) {
            return;
        }
        const id = `${baseId}-${iso.toLowerCase()}`;
        if (!planned.has(id)) {
            planned.set(id, { id, name, nameEn: props.name_en || name, iso });
        }
    });
    
    await initDatabase();
    const existing = await query(`SELECT id FROM territories WHERE id = ANY($1)`, [[...planned.keys()]]);
    const existingIds = new Set(existing.rows.map(r => r.id));
    const toInsert = [...planned.values()].filter(row => !existingIds.has(row.id));
    
    console.log(`[Collisions] New IDs: ${planned.size}, already exist: ${existingIds.size}, to insert: ${toInsert.length}`);
    console.log(`[Collisions] Sample: ${toInsert.slice(0, 15).map(r => `${r.id}(${r.name})`).join(', ')}`);
    
    if (!apply) {
        console.log('[Collisions] Dry run complete. Run with --apply to insert.');
        return;
    }
    
    let inserted = 0;
    for (const row of toInsert) {
        const result = await query(
            `INSERT INTO territories (id, code, name, name_en, country, country_iso, status, sovereignty, base_price, created_at, updated_at)
             VALUES ($1, $1, $2, $3, $4, $5, 'unconquered', 'unconquered', 0, NOW(), NOW())
             ON CONFLICT (id) DO NOTHING`,
            [row.id, row.name, row.nameEn, row.iso.toLowerCase(), row.iso]
        );
        inserted += result.rowCount;
    }
    console.log(`[Collisions] Inserted ${inserted} territories`);
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error('[Collisions] Failed:', error);
        process.exit(1);
    });
