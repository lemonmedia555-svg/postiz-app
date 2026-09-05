import { createHmac } from 'crypto';
import { verifyMetaInstagramSignedRequest } from './meta.instagram.callback';

const toBase64Url = (value: Buffer | string) =>
  Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

const sign = (payload: Record<string, unknown>, secret = 'test-secret') => {
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret)
    .update(encodedPayload)
    .digest();
  return `${toBase64Url(signature)}.${encodedPayload}`;
};

describe('verifyMetaInstagramSignedRequest', () => {
  it('accepts a current, correctly signed request', () => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const signedRequest = sign({
      algorithm: 'HMAC-SHA256',
      issued_at: issuedAt,
      user_id: '123456',
    });

    expect(
      verifyMetaInstagramSignedRequest(signedRequest, 'test-secret')
    ).toEqual({ userId: '123456', issuedAt });
  });

  it('rejects a request signed with a different secret', () => {
    const signedRequest = sign({
      algorithm: 'HMAC-SHA256',
      issued_at: Math.floor(Date.now() / 1000),
      user_id: '123456',
    });

    expect(() =>
      verifyMetaInstagramSignedRequest(signedRequest, 'wrong-secret')
    ).toThrow('Invalid signed request signature');
  });

  it('rejects an expired request', () => {
    const signedRequest = sign({
      algorithm: 'HMAC-SHA256',
      issued_at: Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 8,
      user_id: '123456',
    });

    expect(() =>
      verifyMetaInstagramSignedRequest(signedRequest, 'test-secret')
    ).toThrow('Signed request is expired');
  });
});
