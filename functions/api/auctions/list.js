/**
 * Cloudflare Pages Functions - Auctions List API
 * Firebase REST API 사용 (Edge Runtime 호환)
 */

export async function onRequest(context) {
  const { env } = context;
  
  try {
    // Firebase REST API 사용
    const projectId = env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/auctions`;
    
    // status가 'active'인 경매만 조회
    const queryUrl = `${firestoreUrl}?where=status%3D%3Dactive`;
    
    const response = await fetch(queryUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Firestore API error: ${response.status}`);
    }
    
    const firestoreData = await response.json();
    
    // Firestore REST API 응답을 일반 객체 배열로 변환
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
    
    // status가 'active'인 것만 필터링 (REST API 쿼리가 작동하지 않을 수 있으므로)
    auctions = auctions.filter(auction => auction.status === 'active');
    
    return new Response(JSON.stringify({ 
      auctions,
      count: auctions.length,
      cached: true
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300, s-maxage=600'
      }
    });
    
  } catch (error) {
    console.error('Error fetching auctions:', error);
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
