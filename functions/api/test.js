/**
 * Cloudflare Pages Functions - Test API
 * Functions가 정상 작동하는지 확인하는 간단한 테스트
 */

export async function onRequest() {
  return new Response(JSON.stringify({ 
    message: 'Functions are working!',
    timestamp: new Date().toISOString(),
    status: 'ok'
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

