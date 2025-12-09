/**
 * Territory Seed Script
 * GeoJSON 데이터를 기반으로 Firestore에 territories 컬렉션 생성
 * 
 * 사용법:
 * 1. Node.js 환경에서 실행: node scripts/seed-territories.js
 * 2. 또는 브라우저 콘솔에서 실행: seedTerritories() 함수 호출
 */

// Node.js 환경용 (Firebase Admin SDK 사용)
if (typeof require !== 'undefined') {
    const admin = require('firebase-admin');
    const fs = require('fs');
    const path = require('path');
    
    // Firebase Admin 초기화
    const serviceAccount = require('../FIREBASE_SERVICE_ACCOUNT_ONELINE.json') || 
                          JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    }
    
    const db = admin.firestore();
    
    /**
     * GeoJSON 파일에서 territories 생성
     */
    async function seedTerritoriesFromGeoJSON() {
        try {
            console.log('🌱 Territory seed 시작...');
            
            // GeoJSON 파일 읽기
            const geoJsonPath = path.join(__dirname, '../data/world-regions.geojson');
            const geoJsonData = JSON.parse(fs.readFileSync(geoJsonPath, 'utf8'));
            
            if (!geoJsonData.features || !Array.isArray(geoJsonData.features)) {
                throw new Error('Invalid GeoJSON format');
            }
            
            console.log(`📊 총 ${geoJsonData.features.length}개의 territory 발견`);
            
            // Batch write (Firestore는 한 번에 최대 500개까지)
            const BATCH_SIZE = 500;
            let totalCreated = 0;
            let totalSkipped = 0;
            
            for (let i = 0; i < geoJsonData.features.length; i += BATCH_SIZE) {
                const batch = db.batch();
                const batchFeatures = geoJsonData.features.slice(i, i + BATCH_SIZE);
                
                for (const feature of batchFeatures) {
                    const territoryId = feature.properties.id || 
                                      feature.properties.territoryId || 
                                      feature.properties.name?.toLowerCase().replace(/\s+/g, '-') ||
                                      `territory-${i}`;
                    
                    const territoryRef = db.collection('territories').doc(territoryId);
                    
                    // 이미 존재하는지 확인 (선택사항)
                    const doc = await territoryRef.get();
                    if (doc.exists) {
                        totalSkipped++;
                        continue;
                    }
                    
                    // Territory 데이터 생성
                    const territoryData = {
                        id: territoryId,
                        name: feature.properties.name || feature.properties.name_en || territoryId,
                        country: feature.properties.country || 
                                feature.properties.adm0_a3?.toLowerCase() || 
                                null,
                        countryCode: feature.properties.adm0_a3 || 
                                   feature.properties.iso_a2 || 
                                   null,
                        sovereignty: 'unconquered',
                        viewCount: 0,
                        price: null, // TerritoryDataService에서 계산됨
                        ruler: null,
                        rulerName: null,
                        rulerSince: null,
                        protectedUntil: null,
                        territoryValue: 0,
                        pixelCount: 0,
                        hasPixelArt: false,
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                        // GeoJSON properties 저장
                        properties: feature.properties,
                        // 지오메트리 정보 (선택사항, 크기가 클 수 있음)
                        // geometry: feature.geometry // 필요시 주석 해제
                    };
                    
                    batch.set(territoryRef, territoryData);
                    totalCreated++;
                }
                
                // Batch commit
                await batch.commit();
                console.log(`✅ Batch ${Math.floor(i / BATCH_SIZE) + 1} 완료: ${batchFeatures.length}개 처리`);
            }
            
            console.log(`\n🎉 Seed 완료!`);
            console.log(`   - 생성: ${totalCreated}개`);
            console.log(`   - 건너뜀: ${totalSkipped}개 (이미 존재)`);
            console.log(`   - 총: ${geoJsonData.features.length}개`);
            
        } catch (error) {
            console.error('❌ Seed 실패:', error);
            throw error;
        }
    }
    
    // 실행
    if (require.main === module) {
        seedTerritoriesFromGeoJSON()
            .then(() => {
                console.log('✅ Seed 스크립트 완료');
                process.exit(0);
            })
            .catch((error) => {
                console.error('❌ Seed 스크립트 실패:', error);
                process.exit(1);
            });
    }
    
    module.exports = { seedTerritoriesFromGeoJSON };
}

// 브라우저 환경용 (클라이언트 SDK 사용)
if (typeof window !== 'undefined') {
    /**
     * 브라우저 콘솔에서 실행 가능한 함수
     * 맵에서 로드된 GeoJSON 데이터를 사용하여 territories 생성
     * 또는 직접 GeoJSON 파일을 로드하여 생성
     */
    window.seedTerritories = async function(options = {}) {
        try {
            console.log('🌱 Territory seed 시작...');
            
            let geoJsonData = null;
            
            // 옵션 1: 맵에서 로드된 데이터 사용 (권장)
            if (options.useMapData) {
                // 여러 방법으로 mapController 접근 시도
                let mapController = window.mapController || 
                                  (window.app && window.app.mapController) ||
                                  (window.BillionaireApp && window.BillionaireApp.mapController);
                
                if (mapController && mapController.map) {
                    const map = mapController.map;
                    const source = map.getSource('world-territories');
                    if (source && source._data) {
                        geoJsonData = source._data;
                        console.log('📊 맵에서 로드된 GeoJSON 데이터 사용');
                    } else {
                        console.warn('⚠️ 맵 소스에서 데이터를 찾을 수 없습니다. 파일을 로드합니다.');
                    }
                } else {
                    console.warn('⚠️ 맵 컨트롤러를 찾을 수 없습니다. 파일을 로드합니다.');
                }
            }
            
            // 옵션 2: GeoJSON 파일 직접 로드
            if (!geoJsonData) {
                const geoJsonUrl = options.geoJsonUrl || '/data/world-regions.geojson';
                console.log(`📂 GeoJSON 파일 로드: ${geoJsonUrl}`);
                const response = await fetch(geoJsonUrl);
                geoJsonData = await response.json();
            }
            
            if (!geoJsonData.features || !Array.isArray(geoJsonData.features)) {
                throw new Error('Invalid GeoJSON format');
            }
            
            console.log(`📊 총 ${geoJsonData.features.length}개의 territory 발견`);
            
            // Firebase Service 확인 (여러 방법으로 접근 시도)
            let firebaseService = window.firebaseService || 
                                 (window.app && window.app.firebaseService) ||
                                 (window.BillionaireApp && window.BillionaireApp.firebaseService);
            
            // Firebase 설정 가져오기 (CONFIG에서)
            let firebaseConfig = null;
            if (window.CONFIG && window.CONFIG.FIREBASE) {
                firebaseConfig = window.CONFIG.FIREBASE;
            } else {
                // 기본 설정 (config.js에서 가져옴)
                firebaseConfig = {
                    apiKey: "AIzaSyAa0BTlcqX9T1PYaHTiv3CmjmZ6srmdZVY",
                    authDomain: "worldad-8be07.firebaseapp.com",
                    projectId: "worldad-8be07",
                    storageBucket: "worldad-8be07.firebasestorage.app",
                    messagingSenderId: "460480155784",
                    appId: "1:460480155784:web:68e6cea86cf492b3b64f3d"
                };
            }
            
            if (!firebaseService || !firebaseService.initialized) {
                // 추가 확인: window.firebaseModules가 있으면 직접 사용 가능
                if (window.firebaseModules && window.firebaseModules.firestore) {
                    console.warn('⚠️ FirebaseService 인스턴스를 찾을 수 없지만, Firebase 모듈은 사용 가능합니다.');
                    console.warn('   직접 Firestore 접근을 시도합니다...');
                    
                    // 직접 Firestore 초기화 시도
                    const { initializeApp, getApps } = window.firebaseModules.app;
                    const { getFirestore, doc, setDoc, getDoc, serverTimestamp } = window.firebaseModules.firestore;
                    
                    // Firebase 앱 초기화 (이미 초기화되어 있을 수 있음)
                    let app;
                    try {
                        const apps = getApps();
                        if (apps.length > 0) {
                            app = apps[0];
                            console.log('✅ 기존 Firebase 앱 사용');
                        } else {
                            app = initializeApp(firebaseConfig);
                            console.log('✅ 새 Firebase 앱 초기화');
                        }
                    } catch (e) {
                        // 이미 초기화되어 있을 수 있음
                        const apps = getApps();
                        if (apps.length > 0) {
                            app = apps[0];
                            console.log('✅ 기존 Firebase 앱 사용 (catch)');
                        } else {
                            throw new Error('Firebase 앱을 초기화할 수 없습니다: ' + e.message);
                        }
                    }
                    
                    if (!app) {
                        throw new Error('Firebase 앱을 초기화할 수 없습니다. Firebase 설정을 확인하세요.');
                    }
                    
                    const db = getFirestore(app);
                    
                    // 임시 firebaseService 객체 생성
                    firebaseService = {
                        initialized: true,
                        db: db,
                        _firestore: {
                            doc, setDoc, getDoc, serverTimestamp
                        }
                    };
                    
                    console.log('✅ Firebase 모듈을 직접 사용하여 Firestore 접근');
                } else {
                    throw new Error('Firebase Service가 초기화되지 않았습니다. 페이지를 새로고침하거나 Firebase 설정을 확인하세요.');
                }
            }
            const { doc, setDoc, getDoc, serverTimestamp } = firebaseService._firestore;
            
            // Batch write (Firestore는 한 번에 최대 500개까지)
            const BATCH_SIZE = options.batchSize || 50; // 브라우저에서는 더 작게
            let totalCreated = 0;
            let totalSkipped = 0;
            let totalErrors = 0;
            
            for (let i = 0; i < geoJsonData.features.length; i += BATCH_SIZE) {
                const batchFeatures = geoJsonData.features.slice(i, i + BATCH_SIZE);
                const promises = [];
                
                for (const feature of batchFeatures) {
                    // Territory ID 추출 (MapController의 normalizeTerritoryId 로직과 동일)
                    let territoryId = feature.properties.id || 
                                     feature.properties.territoryId;
                    
                    if (!territoryId) {
                        const name = feature.properties.name || 
                                    feature.properties.name_en || 
                                    feature.properties.name_ko;
                        if (name) {
                            territoryId = String(name)
                                .toLowerCase()
                                .trim()
                                .replace(/[^\w\s-]/g, '')
                                .replace(/\s+/g, '-')
                                .replace(/-+/g, '-')
                                .replace(/^-|-$/g, '');
                        }
                    }
                    
                    if (!territoryId) {
                        console.warn(`⚠️ Territory ID를 찾을 수 없음, 건너뜀:`, feature.properties);
                        totalSkipped++;
                        continue;
                    }
                    
                    const territoryRef = doc(firebaseService.db, 'territories', territoryId);
                    
                    // 이미 존재하는지 확인
                    const docSnap = await getDoc(territoryRef);
                    if (docSnap.exists()) {
                        totalSkipped++;
                        continue;
                    }
                    
                    // 국가 코드 추출
                    let country = null;
                    if (feature.properties.adm0_a3) {
                        // ISO 코드를 슬러그로 변환 (TerritoryManager 로직 참고)
                        const isoCode = feature.properties.adm0_a3.toUpperCase();
                        // 간단한 매핑 (주요 국가만)
                        const isoToSlug = {
                            'USA': 'usa', 'KOR': 'south-korea', 'JPN': 'japan',
                            'CHN': 'china', 'GBR': 'united-kingdom', 'FRA': 'france',
                            'DEU': 'germany', 'ITA': 'italy', 'ESP': 'spain',
                            'CAN': 'canada', 'AUS': 'australia', 'BRA': 'brazil',
                            'IND': 'india', 'RUS': 'russia', 'MEX': 'mexico',
                            'NGA': 'nigeria', 'ZAF': 'south-africa', 'EGY': 'egypt',
                            'NER': 'niger', 'MLI': 'mali', 'MRT': 'mauritania'
                        };
                        country = isoToSlug[isoCode] || feature.properties.adm0_a3.toLowerCase();
                    }
                    
                    // Territory 데이터 생성
                    const territoryData = {
                        id: territoryId,
                        name: feature.properties.name || 
                             feature.properties.name_en || 
                             feature.properties.name_ko || 
                             territoryId,
                        country: country || 
                                feature.properties.country?.toLowerCase() || 
                                null,
                        countryCode: feature.properties.adm0_a3 || 
                                   feature.properties.iso_a2 || 
                                   null,
                        sovereignty: 'unconquered',
                        viewCount: 0,
                        price: null, // TerritoryDataService에서 계산됨
                        ruler: null,
                        rulerName: null,
                        rulerSince: null,
                        protectedUntil: null,
                        territoryValue: 0,
                        pixelCount: 0,
                        hasPixelArt: false,
                        createdAt: serverTimestamp(),
                        updatedAt: serverTimestamp(),
                        // GeoJSON properties 저장 (필요한 정보만)
                        properties: {
                            ...feature.properties,
                            id: territoryId,
                            territoryId: territoryId
                        }
                    };
                    
                    promises.push(
                        setDoc(territoryRef, territoryData)
                            .then(() => {
                                totalCreated++;
                                if (totalCreated % 10 === 0) {
                                    console.log(`   진행 중... ${totalCreated}개 생성됨`);
                                }
                            })
                            .catch((error) => {
                                console.error(`❌ Territory ${territoryId} 생성 실패:`, error);
                                totalErrors++;
                            })
                    );
                }
                
                await Promise.all(promises);
                console.log(`✅ Batch ${Math.floor(i / BATCH_SIZE) + 1} 완료: ${batchFeatures.length}개 처리 (생성: ${totalCreated}, 건너뜀: ${totalSkipped}, 오류: ${totalErrors})`);
                
                // 브라우저에서는 약간의 지연 추가 (rate limiting 방지)
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            
            console.log(`\n🎉 Seed 완료!`);
            console.log(`   - 생성: ${totalCreated}개`);
            console.log(`   - 건너뜀: ${totalSkipped}개 (이미 존재)`);
            console.log(`   - 오류: ${totalErrors}개`);
            console.log(`   - 총: ${geoJsonData.features.length}개`);
            
            return {
                created: totalCreated,
                skipped: totalSkipped,
                errors: totalErrors,
                total: geoJsonData.features.length
            };
            
        } catch (error) {
            console.error('❌ Seed 실패:', error);
            throw error;
        }
    };
    
    console.log('✅ seedTerritories() 함수가 전역으로 등록되었습니다.');
    console.log('   사용법:');
    console.log('   - seedTerritories() - 기본 GeoJSON 파일 사용');
    console.log('   - seedTerritories({ useMapData: true }) - 맵에서 로드된 데이터 사용');
}

