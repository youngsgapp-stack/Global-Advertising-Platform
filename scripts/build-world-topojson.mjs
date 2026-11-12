/**
 * data/world-admin1.v1.json (GeoJSON) → data/world-admin1.v2.json (TopoJSON)
 * 이웃 땅이 공유하는 경계선을 한 번만 저장해서 용량을 줄임 (모양·속성·순서는 그대로)
 * 좌표 반올림으로 생기는 미세한 차이가 픽셀 그리드 위치에 영향을 주지 않도록
 * 땅마다 원래 경계 상자를 properties._bb 에 그대로 넣어 둠 (브라우저에서 geometry.bbox 로 옮김)
 *
 * 실행: npm i topojson-server && node scripts/build-world-topojson.mjs
 */
import { readFileSync, writeFileSync } from 'fs';
import { topology } from 'topojson-server';

const input = process.argv[2] || 'data/world-admin1.v1.json';
const output = process.argv[3] || 'data/world-admin1.v2.json';
const QUANTIZATION = 1e6;

const geo = JSON.parse(readFileSync(input, 'utf8'));
const round6 = (v) => Math.round(v * 1e6) / 1e6;

for (const feature of geo.features) {
    if (!feature.geometry) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const walk = (c) => {
        if (typeof c[0] === 'number') {
            if (c[0] < minX) minX = c[0];
            if (c[0] > maxX) maxX = c[0];
            if (c[1] < minY) minY = c[1];
            if (c[1] > maxY) maxY = c[1];
        } else c.forEach(walk);
    };
    walk(feature.geometry.coordinates);
    feature.properties = { ...feature.properties, _bb: [minX, minY, maxX, maxY].map(round6) };
}

const topo = topology({ territories: geo }, QUANTIZATION);
writeFileSync(output, JSON.stringify(topo));
console.log(`${output}: ${geo.features.length} features, ${(JSON.stringify(topo).length / 1e6).toFixed(2)} MB`);
