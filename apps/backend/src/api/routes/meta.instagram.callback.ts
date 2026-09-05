import { createHmac, timingSafeEqual } from 'crypto';

type MetaSignedRequest = {
  algorithm?: string;
  issued_at?: number;
  user_id?: string | number;
};

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4;
  return Buffer.from(
    normalized + (padding ? '='.repeat(4 - padding) : ''),
    'base64'
  );
}

export function verifyMetaInstagramSignedRequest(
  signedRequest: string,
  secret: string
): { userId: string; issuedAt?: number } {
  if (!signedRequest || !secret) {
    throw new Error('Missing signed request or Instagram app secret');
  }

  const [encodedSignature, encodedPayload, ...rest] = signedRequest.split('.');
  if (!encodedSignature || !encodedPayload || rest.length) {
    throw new Error('Invalid signed request format');
  }

  const signature = decodeBase64Url(encodedSignature);
  const expected = createHmac('sha256', secret).update(encodedPayload).digest();
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(signature, expected)
  ) {
    throw new Error('Invalid signed request signature');
  }

  const payload = JSON.parse(
    decodeBase64Url(encodedPayload).toString('utf8')
  ) as MetaSignedRequest;
  if (payload.algorithm && payload.algorithm.toUpperCase() !== 'HMAC-SHA256') {
    throw new Error('Unsupported signed request algorithm');
  }

  const userId = String(payload.user_id || '');
  if (!userId) {
    throw new Error('Signed request does not contain user_id');
  }

  const issuedAt = Number(payload.issued_at || 0);
  const now = Math.floor(Date.now() / 1000);
  if (!issuedAt || issuedAt > now + 300 || issuedAt < now - 60 * 60 * 24 * 7) {
    throw new Error('Signed request is expired');
  }

  return { userId, issuedAt };
}
