/**
 * Scheduled Worker - Firestore → KV 동기화
 * 5분마다 실행되어 Firestore 데이터를 KV에 동기화
 * 
 * 설정 방법:
 * 1. Cloudflare Dashboard → Workers & Pages → Cron Triggers
 * 2. "Add Cron Trigger" 클릭
 * 3. Cron Expression: "0,5,10,15,20,25,30,35,40,45,50,55 * * * *" (5분마다)
 * 4. Worker 선택: 이 파일이 있는 프로젝트
 * 
 * 참고: Cloudflare Pages에서는 functions/scheduled/ 디렉토리에 파일이 있으면
 * 자동으로 Cron Trigger로 인식됩니다.
 */

export default {
  async scheduled(event, env, ctx) {
    // 비동기 작업 실행 (응답 지연 없음)
    ctx.waitUntil(syncTerritories(env));
    ctx.waitUntil(syncAuctions(env));
  }
};

/**
 * Territory 데이터 동기화
 */
async function syncTerritories(env) {
  const projectId = env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const apiKey = env.NEXT_PUBLIC_FIREBASE_API_KEY;
  
  if (!projectId || !apiKey) {
    console.error('[Sync] Firebase configuration missing');
    return;
  }
  
  // 인기 territory만 동기화 (rate limit 방지)
  // TODO: 실제 사용량에 따라 동적으로 조정
  const popularTerritories = [
    'texas', 'california', 'new-york', 'florida', 'illinois',
    'pennsylvania', 'ohio', 'georgia', 'north-carolina', 'michigan'
  ];
  
  let successCount = 0;
  let errorCount = 0;
  
  for (const id of popularTerritories) {
    try {
      const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/territories/${id}?key=${apiKey}`;
      
      const response = await fetch(firestoreUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      if (response.ok) {
        const firestoreData = await response.json();
        const territory = convertFirestoreToObject(firestoreData);
        territory.id = id;
        
        // KV에 저장 (TTL: 1시간)
        await env.TERRITORY_CACHE.put(
          `territory:${id}`,
          JSON.stringify(territory),
          { expirationTtl: 3600 } // 1시간
        );
        
        successCount++;
        console.log(`[Sync] ✅ Territory ${id} synced to KV`);
      } else if (response.status === 429) {
        // Rate limit 발생 시 해당 territory 건너뛰기
        console.warn(`[Sync] ⚠️ Rate limit for territory ${id}, skipping`);
        errorCount++;
      } else {
        console.error(`[Sync] ❌ Failed to sync territory ${id}: ${response.status}`);
        errorCount++;
      }
      
      // Rate limit 방지를 위해 요청 간 지연 (200ms)
      await new Promise(resolve => setTimeout(resolve, 200));
      
    } catch (error) {
      console.error(`[Sync] ❌ Error syncing territory ${id}:`, error);
      errorCount++;
    }
  }
  
  console.log(`[Sync] Territory sync completed: ${successCount} success, ${errorCount} errors`);
}

/**
 * Auction 데이터 동기화
 */
async function syncAuctions(env) {
  const projectId = env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const apiKey = env.NEXT_PUBLIC_FIREBASE_API_KEY;
  
  if (!projectId || !apiKey) {
    console.error('[Sync] Firebase configuration missing');
    return;
  }
  
  try {
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/auctions?key=${apiKey}`;
    
    const response = await fetch(firestoreUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (response.ok) {
      const firestoreData = await response.json();
      let auctions = [];
      
      if (firestoreData.documents) {
        auctions = firestoreData.documents.map(doc => {
          const auction = convertFirestoreToObject(doc);
          // 문서 ID 추출: projects/.../databases/.../documents/auctions/auction_id → auction_id
          const docPath = doc.name.split('/');
          auction.id = docPath[docPath.length - 1];
          return auction;
        });
      }
      
      // status가 'active'인 것만 필터링
      auctions = auctions.filter(auction => auction.status === 'active');
      
      // KV에 저장 (TTL: 5분)
      await env.AUCTION_CACHE.put(
        'auctions:list',
        JSON.stringify({ 
          auctions, 
          count: auctions.length,
          syncedAt: Date.now()
        }),
        { expirationTtl: 300 } // 5분
      );
      
      console.log(`[Sync] ✅ ${auctions.length} active auctions synced to KV`);
    } else if (response.status === 429) {
      console.warn('[Sync] ⚠️ Rate limit for auctions, skipping');
    } else {
      console.error(`[Sync] ❌ Failed to sync auctions: ${response.status}`);
    }
  } catch (error) {
    console.error('[Sync] ❌ Error syncing auctions:', error);
  }
}

/**
 * Firestore REST API 응답을 일반 객체로 변환
 */
function convertFirestoreToObject(firestoreDoc) {
  if (!firestoreDoc.fields) {
    return {};
  }
  
  const result = {};
  for (const [key, value] of Object.entries(firestoreDoc.fields)) {
    result[key] = convertFirestoreValue(value);
  }
  
  return result;
}

/**
 * Firestore 값 타입 변환
 */
function convertFirestoreValue(value) {
  if (value.stringValue !== undefined) {
    return value.stringValue;
  }
  if (value.integerValue !== undefined) {
    return parseInt(value.integerValue, 10);
  }
  if (value.doubleValue !== undefined) {
    return parseFloat(value.doubleValue);
  }
  if (value.booleanValue !== undefined) {
    return value.booleanValue === 'true';
  }
  if (value.timestampValue !== undefined) {
    return new Date(value.timestampValue).getTime();
  }
  if (value.nullValue !== undefined) {
    return null;
  }
  if (value.arrayValue !== undefined) {
    return value.arrayValue.values.map(v => convertFirestoreValue(v));
  }
  if (value.mapValue !== undefined) {
    const result = {};
    if (value.mapValue.fields) {
      for (const [k, v] of Object.entries(value.mapValue.fields)) {
        result[k] = convertFirestoreValue(v);
      }
    }
    return result;
  }
  return value;
}

