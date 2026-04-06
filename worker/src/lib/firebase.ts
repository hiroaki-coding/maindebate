interface FirebaseTokenPayload {
  uid: string;
  email?: string;
  exp: number;
  iat: number;
  aud: string;
  iss: string;
}

interface JWK {
  kid: string;
  kty: string;
  alg: string;
  use: string;
  n: string;
  e: string;
}

// Google公開鍵のキャッシュ
let cachedKeys: { keys: JWK[]; expiresAt: number } | null = null;

async function getFirebasePublicKeys(): Promise<JWK[]> {
  if (cachedKeys && Date.now() < cachedKeys.expiresAt) {
    return cachedKeys.keys;
  }

  const res = await fetch(
    'https://www.googleapis.com/robot/v1/metadata/jwk/securetoken@system.gserviceaccount.com'
  );

  const cacheControl = res.headers.get('cache-control');
  const maxAge = cacheControl?.match(/max-age=(\d+)/)?.[1] ?? '3600';

  const { keys } = (await res.json()) as { keys: JWK[] };
  cachedKeys = {
    keys,
    expiresAt: Date.now() + parseInt(maxAge) * 1000,
  };

  return keys;
}

function base64UrlDecode(str: string): Uint8Array {
  // Base64URL to Base64
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  // パディングを追加
  while (base64.length % 4) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function verifyFirebaseToken(
  token: string,
  projectId: string
): Promise<FirebaseTokenPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid token format');
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // ヘッダーをデコード
  const headerJson = new TextDecoder().decode(base64UrlDecode(headerB64));
  const header = JSON.parse(headerJson);

  // 公開鍵を取得
  const keys = await getFirebasePublicKeys();
  const key = keys.find((k) => k.kid === header.kid);
  if (!key) {
    throw new Error('Key not found');
  }

  // 公開鍵をインポート
  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    key as JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  // 署名を検証
  const signatureArrayBuffer = base64UrlDecode(signatureB64);
  const dataArrayBuffer = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

  const isValid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    signatureArrayBuffer,
    dataArrayBuffer
  );

  if (!isValid) {
    throw new Error('Invalid signature');
  }

  // ペイロードをデコード
  const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64));
  const payload: FirebaseTokenPayload = JSON.parse(payloadJson);

  // クレーム検証
  const now = Math.floor(Date.now() / 1000);

  if (payload.exp < now) {
    throw new Error('Token expired');
  }

  if (payload.iat > now + 60) {
    throw new Error('Token issued in future');
  }

  if (payload.aud !== projectId) {
    throw new Error('Invalid audience');
  }

  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error('Invalid issuer');
  }

  return payload;
}
