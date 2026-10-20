/**
 * 영토 정가(base_price, 1주일 가격) 계산 및 저장 - 등급제
 *
 * 각 행정구역 안에 어떤 도시가 있는지(Natural Earth 도시 데이터, 경계선 내부 판정)로 등급을 정하고,
 * 등급 가격 × 국가 경제 계수(TerritoryDataService.getEconomicFactor)로 정가를 만든다.
 * 구매 시 서버는 이 값을 최저가 기준으로 사용하고, 화면도 이 값을 표시한다.
 *
 * 소유자가 있거나 market_base_price가 설정된 영토는 변경하지 않는다.
 *
 * 실행 방법:
 *   node scripts/compute-territory-prices.js            (미리보기, DB 변경 없음)
 *   node scripts/compute-territory-prices.js --apply    (실제 저장)
 */

import dotenv from 'dotenv';
import { query, initDatabase } from '../db/init.js';

dotenv.config();

// 등급별 1주일 가격 (pt, 100pt = $10)
const TIER_PRICES = {
    S: 500, // 인구 1,000만 이상 도시 또는 인구 500만 이상 수도
    A: 200, // 수도 또는 인구 300만 이상 도시
    B: 100, // 인구 100만 이상 도시
    C: 50   // 나머지
};
const MIN_PRICE = 50;

const ADMIN1_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson';
const PLACES_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places_simple.geojson';

// 프론트엔드 모듈을 Node에서 불러오기 위한 최소 브라우저 객체
const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis.window || { location: { hostname: 'node', search: '' }, addEventListener() {}, localStorage: storage };
globalThis.localStorage = globalThis.localStorage || storage;
globalThis.document = globalThis.document || { addEventListener() {}, getElementById: () => null, querySelector: () => null };

const { territoryDataService } = await import('../../js/services/TerritoryDataService.js');
const { resolveCollidingTerritoryId } = await import('../../js/data/territory-id-collisions.js');

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

function pointInRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

function pointInGeometry(lon, lat, geometry) {
    if (!geometry) return false;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates]
        : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
    return polygons.some(([outer, ...holes]) =>
        pointInRing(lon, lat, outer) && !holes.some(hole => pointInRing(lon, lat, hole)));
}

function tierForCities(cities) {
    if (cities.some(c => c.pop >= 10_000_000 || (c.capital && c.pop >= 5_000_000))) return 'S';
    if (cities.some(c => c.capital || c.pop >= 3_000_000)) return 'A';
    if (cities.some(c => c.pop >= 1_000_000)) return 'B';
    return 'C';
}

async function main() {
    const apply = process.argv.includes('--apply');
    console.log(`[Prices] ${apply ? 'APPLY' : 'DRY RUN (no changes)'}`);
    
    console.log('[Prices] Downloading Natural Earth data...');
    const [admin1, places] = await Promise.all([
        fetch(ADMIN1_URL).then(r => r.json()),
        fetch(PLACES_URL).then(r => r.json())
    ]);
    
    // 등급 판정에 쓰는 도시만 (수도 또는 인구 100만 이상)
    const citiesByCountry = new Map();
    for (const place of places.features) {
        const p = place.properties;
        const capital = p.adm0cap === 1 || /Admin-0 capital/.test(p.featurecla || '');
        if (!capital && !(p.pop_max >= 1_000_000)) continue;
        const iso = String(p.adm0_a3 || '').toUpperCase();
        if (!citiesByCountry.has(iso)) citiesByCountry.set(iso, []);
        citiesByCountry.get(iso).push({ name: p.name, pop: p.pop_max || 0, capital, lon: p.longitude, lat: p.latitude });
    }
    
    // MapController.getWorldTerritoryId()와 같은 규칙으로 ID 생성 후 등급/가격 계산
    const prices = new Map();
    admin1.features.forEach((feature, index) => {
        const props = feature.properties || {};
        const name = props.name || props.name_en || `Region ${index}`;
        const iso = String(props.adm0_a3 || '').toUpperCase();
        const id = resolveCollidingTerritoryId(slugify(name) || `world-${index}`, iso);
        
        const cities = (citiesByCountry.get(iso) || []).filter(c => pointInGeometry(c.lon, c.lat, feature.geometry));
        const tier = tierForCities(cities);
        const factor = territoryDataService.getEconomicFactor(iso);
        const price = Math.max(MIN_PRICE, Math.round((TIER_PRICES[tier] * factor) / 10) * 10);
        
        // 같은 나라 안에 같은 이름이 여러 개면 비싼 쪽 사용
        const prev = prices.get(id);
        if (!prev || price > prev.price) {
            prices.set(id, { price, tier, city: cities.sort((a, b) => b.pop - a.pop)[0]?.name || null });
        }
    });
    
    await initDatabase();
    const rows = await query(`SELECT id, name, base_price, market_base_price, ruler_id FROM territories`);
    
    const updates = [];
    let skippedOwned = 0;
    let notInMap = 0;
    for (const row of rows.rows) {
        const entry = prices.get(row.id);
        if (!entry) {
            notInMap++;
            continue;
        }
        if (row.ruler_id || parseFloat(row.market_base_price || 0) > 0) {
            skippedOwned++;
            continue;
        }
        if (parseFloat(row.base_price || 0) !== entry.price) {
            updates.push({ id: row.id, ...entry });
        }
    }
    
    const tierCounts = {};
    for (const u of updates) tierCounts[u.tier] = (tierCounts[u.tier] || 0) + 1;
    console.log(`[Prices] DB rows: ${rows.rows.length}, to update: ${updates.length}, skipped (owned/market price): ${skippedOwned}, not on map: ${notInMap}`);
    console.log(`[Prices] Tiers: ${JSON.stringify(tierCounts)}`);
    const showcase = ['seoul', 'tokyo', 'new-york', 'california', 'texas', 'greater-london', 'paris', 'gyeonggi', 'busan', 'osaka', 'amazonas', 'amazonas-ven', 'lara', 'western-ken'];
    console.log(`[Prices] Examples: ${showcase.map(id => {
        const e = prices.get(id);
        return e ? `${id}=${e.price}(${e.tier}${e.city ? ', ' + e.city : ''})` : `${id}=-`;
    }).join(', ')}`);
    const top = [...prices.entries()].sort((a, b) => b[1].price - a[1].price).slice(0, 15);
    console.log(`[Prices] Most expensive: ${top.map(([id, e]) => `${id}=${e.price}`).join(', ')}`);
    
    if (!apply) {
        console.log('[Prices] Dry run complete. Run with --apply to save.');
        return;
    }
    
    let saved = 0;
    for (const u of updates) {
        const result = await query(
            `UPDATE territories SET base_price = $1, updated_at = NOW()
             WHERE id = $2 AND ruler_id IS NULL AND COALESCE(market_base_price, 0) = 0`,
            [u.price, u.id]
        );
        saved += result.rowCount;
    }
    console.log(`[Prices] Saved ${saved} prices`);
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error('[Prices] Failed:', error);
        process.exit(1);
    });
