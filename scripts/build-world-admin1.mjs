import { readFileSync, writeFileSync } from 'fs';
import { gzipSync, brotliCompressSync } from 'zlib';
import { pathToFileURL } from 'url';

const [input, output, repo] = process.argv.slice(2);
const { getPixelGridBounds, gridToLngLat } = await import(pathToFileURL(`${repo}/js/core/PixelGridProjection.js`).href);

const KEEP_PROPS = ['name', 'name_en', 'name_local', 'name_ko', 'name_ja', 'name_zh', 'woe_name', 'adm0_a3', 'sov_a3', 'admin',
    'geonunit', 'iso_a2', 'iso_3166_2', 'adm1_code', 'ne_id', 'type', 'type_en', 'region', 'area_sqkm'];
const MAX_TOLERANCE = Number(process.env.MAX_TOLERANCE || 0.002);

function walkPoints(coords, fn) {
    if (typeof coords[0] === 'number') fn(coords);
    else coords.forEach(c => walkPoints(c, fn));
}

function bboxOf(geometry) {
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    walkPoints(geometry.coordinates, ([x, y]) => {
        if (x < minLng) minLng = x;
        if (x > maxLng) maxLng = x;
        if (y < minLat) minLat = y;
        if (y > maxLat) maxLat = y;
    });
    return { minLng, maxLng, minLat, maxLat };
}

function perpendicularDistanceSq(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    if (dx === 0 && dy === 0) return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    return (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2;
}

/** Douglas-Peucker; forced 인덱스(경계 극점)는 항상 유지 */
function simplifyRing(ring, tolerance, isForced) {
    if (ring.length <= 4) return ring;
    const keep = new Uint8Array(ring.length);
    keep[0] = keep[ring.length - 1] = 1;
    for (let i = 0; i < ring.length; i++) if (isForced(ring[i])) keep[i] = 1;
    const tolSq = tolerance * tolerance;
    const anchors = [];
    for (let i = 0; i < ring.length; i++) if (keep[i]) anchors.push(i);
    const stack = [];
    for (let k = 0; k < anchors.length - 1; k++) stack.push([anchors[k], anchors[k + 1]]);
    while (stack.length) {
        const [s, e] = stack.pop();
        let maxD = 0, idx = -1;
        for (let i = s + 1; i < e; i++) {
            const d = perpendicularDistanceSq(ring[i], ring[s], ring[e]);
            if (d > maxD) { maxD = d; idx = i; }
        }
        if (idx >= 0 && maxD > tolSq) {
            keep[idx] = 1;
            stack.push([s, idx], [idx, e]);
        }
    }
    const out = [];
    for (let i = 0; i < ring.length; i++) if (keep[i]) out.push(ring[i]);
    return out.length < 4 ? ring : out;
}

function simplifyGeometry(geometry, tolerance, bbox, precision) {
    const isForced = ([x, y]) => x === bbox.minLng || x === bbox.maxLng || y === bbox.minLat || y === bbox.maxLat;
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const round = v => Math.round(v * precision) / precision;
    const doRing = ring => {
        const simplified = simplifyRing(ring, tolerance, isForced);
        const rounded = [];
        for (const [x, y] of simplified) {
            const p = isForced([x, y])
                ? [x, y]
                : [clamp(round(x), bbox.minLng, bbox.maxLng), clamp(round(y), bbox.minLat, bbox.maxLat)];
            const last = rounded[rounded.length - 1];
            if (!last || last[0] !== p[0] || last[1] !== p[1]) rounded.push(p);
        }
        if (rounded.length >= 2) {
            const first = rounded[0], last = rounded[rounded.length - 1];
            if (first[0] !== last[0] || first[1] !== last[1]) rounded.push([first[0], first[1]]);
        }
        return rounded.length >= 4 ? rounded : simplified;
    };
    if (geometry.type === 'Polygon') return { type: 'Polygon', coordinates: geometry.coordinates.map(doRing) };
    return { type: 'MultiPolygon', coordinates: geometry.coordinates.map(poly => poly.map(doRing)) };
}

// TerritoryMask와 동일한 판정 (외곽 링만 사용)
function maskOf(geometry, bounds, size = 128) {
    const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    const cells = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const { lng, lat } = gridToLngLat(x + 0.5, y + 0.5, bounds, size, size);
            let inside = false;
            for (const poly of polys) {
                const c = poly[0];
                for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
                    const [xi, yi] = c[i], [xj, yj] = c[j];
                    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
                }
            }
            cells[y * size + x] = inside ? 1 : 0;
        }
    }
    return cells;
}

const data = JSON.parse(readFileSync(input, 'utf8'));
const out = { type: 'FeatureCollection', features: [] };
const diffs = [];
let boundsChanged = 0;
const checkEvery = Number(process.env.CHECK_EVERY || 1);

data.features.forEach((feature, index) => {
    const bbox = bboxOf(feature.geometry);
    const cellSize = Math.min(bbox.maxLng - bbox.minLng, bbox.maxLat - bbox.minLat) / 128;
    const tolerance = Math.min(MAX_TOLERANCE, cellSize * 0.25);
    const step = Math.min(1e-3, Math.max(1e-5, 10 ** Math.floor(Math.log10(cellSize * 0.05))));
    const geometry = simplifyGeometry(feature.geometry, tolerance, bbox, Math.round(1 / step));
    const props = {};
    for (const key of KEEP_PROPS) {
        if (feature.properties[key] !== undefined && feature.properties[key] !== null && feature.properties[key] !== '') {
            props[key] = feature.properties[key];
        }
    }
    const newFeature = { type: 'Feature', properties: props, geometry };
    if (feature.id !== undefined) newFeature.id = feature.id;
    out.features.push(newFeature);

    const nb = bboxOf(geometry);
    if (nb.minLng !== bbox.minLng || nb.maxLng !== bbox.maxLng || nb.minLat !== bbox.minLat || nb.maxLat !== bbox.maxLat) {
        boundsChanged++;
        console.log('bounds changed:', index, feature.properties.name, bbox, nb);
    }
    if (index % checkEvery === 0) {
        const bounds = getPixelGridBounds(bbox);
        const a = maskOf(feature.geometry, bounds);
        const b = maskOf(geometry, bounds);
        let inside = 0, diff = 0;
        for (let i = 0; i < a.length; i++) {
            inside += a[i];
            if (a[i] !== b[i]) diff++;
        }
        diffs.push({ index, name: feature.properties.name, inside, diff, pct: inside ? diff / inside : 0 });
    }
});

const json = JSON.stringify(out);
writeFileSync(output, json);
diffs.sort((x, y) => y.pct - x.pct);
const totalDiff = diffs.reduce((s, d) => s + d.diff, 0);
const totalInside = diffs.reduce((s, d) => s + d.inside, 0);
console.log({
    features: out.features.length,
    rawMB: (json.length / 1e6).toFixed(2),
    gzipMB: (gzipSync(json).length / 1e6).toFixed(2),
    brotliMB: (brotliCompressSync(json).length / 1e6).toFixed(2),
    boundsChanged,
    checked: diffs.length,
    totalCellDiffPct: (100 * totalDiff / totalInside).toFixed(4),
    over1pct: diffs.filter(d => d.pct > 0.01).length,
    worst: diffs.slice(0, 5).map(d => `${d.name}: ${d.diff}/${d.inside}`)
});
