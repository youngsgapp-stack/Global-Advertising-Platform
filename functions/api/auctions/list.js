/**
 * Cloudflare Pages Functions - Auctions List API
 */

async function getFirestoreInstance(env) {
  const { initializeApp } = await import('firebase/app');
  const { getFirestore } = await import('firebase/firestore');
  
  const firebaseConfig = {
    apiKey: env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.NEXT_PUBLIC_FIREBASE_APP_ID
  };
  
  const app = initializeApp(firebaseConfig);
  return getFirestore(app);
}

export async function onRequest(context) {
  const { env } = context;
  
  try {
    const firestore = await getFirestoreInstance(env);
    const { collection, query, where, getDocs } = await import('firebase/firestore');
    
    const auctionsRef = collection(firestore, 'auctions');
    const q = query(auctionsRef, where('status', '==', 'active'));
    const querySnapshot = await getDocs(q);
    
    const auctions = querySnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
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

