/**
 * Cloudflare Pages Functions - Auctions List API
 * Firebase REST API 사용 (Edge Runtime 호환)
 * 캐싱 계층 도입: Edge Cache → Firestore
 */

export async function onRequest(context) {
  const { request, env } = context;
  
  try {
    // Firebase REST API 사용
    const projectId = env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    const apiKey = env.NEXT_PUBLIC_FIREBASE_API_KEY;
    
    if (!projectId || !apiKey) {
      return new Response(JSON.stringify({ 
        error: 'Configuration error',
        message: 'Firebase configuration missing' 
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    
    // 캐시 설정 (전문가 조언: 응급처방 - TTL 크게 늘리기)
    const cacheTTL = 300; // 5분 캐시 (응급처방: 1~5분)
    
    // 1. 먼저 KV에서 찾기 (KV 우선 조회)
    if (env.AUCTION_CACHE) {
      const kvData = await env.AUCTION_CACHE.get('auctions:list');
      
      if (kvData) {
        // KV 히트 - 즉시 반환 (Firestore 호출 없음)
        const data = JSON.parse(kvData);
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': `public, max-age=${cacheTTL}, s-maxage=${cacheTTL}`,
            'X-Cache-Status': 'KV-HIT'
          }
        });
      }
    }
    
    // 2. KV 미스 - Edge Cache에서 찾기 (폴백)
    const cache = caches.default;
    const cachedResponse = await cache.match(request);
    
    if (cachedResponse) {
      // Edge Cache 히트 - 즉시 반환 (Firestore 호출 없음)
      const cachedData = await cachedResponse.json();
      return new Response(JSON.stringify(cachedData), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': `public, max-age=${cacheTTL}, s-maxage=${cacheTTL}`,
          'X-Cache-Status': 'EDGE-HIT'
        }
      });
    }
    
    // 3. 모두 미스 - 빈 배열 반환 (Firestore 호출 안 함)
    // Scheduled Worker가 KV에 동기화하므로 직접 호출하지 않음
    const placeholderData = {
      auctions: [],
      count: 0,
      cached: false,
      status: 'loading',
      message: 'Auction data is being synchronized. Please try again in a moment.',
      retryInSeconds: 30
    };
    
    // Placeholder 응답도 Edge Cache에 저장
    const placeholderResponse = new Response(JSON.stringify(placeholderData), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=30, s-maxage=60',
        'X-Cache-Status': 'KV-MISS',
        'X-Placeholder': 'true'
      }
    });
    
    context.waitUntil(cache.put(request, placeholderResponse.clone()));
    
    return placeholderResponse;
  } catch (error) {
    console.error('Error in auctions API:', error);
    return new Response(JSON.stringify({ 
      error: 'Internal server error',
      message: error.message 
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
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