import 'reflect-metadata';
import type { Integration } from '@prisma/client';
import { timer } from '@gitroom/helpers/utils/timer';
import {
  providerFetch,
  withProviderAuthorization,
} from '@gitroom/nestjs-libraries/integrations/provider.authorization';

// Keep the actual provider and SocialAbstract request/retry code. Only replace
// time, native image processing and network infrastructure in this local suite.
jest.mock('@gitroom/helpers/utils/timer', () => ({ timer: jest.fn() }));
jest.mock('@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher', () => ({
  getSsrfSafeDispatcher: jest.fn(),
  getSsrfSafeAxios: jest.fn(),
}));
jest.mock('@gitroom/helpers/utils/read.or.fetch', () => ({
  readOrFetch: jest.fn(),
}));
jest.mock('sharp', () => jest.fn());

import { InstagramProvider } from '@gitroom/nestjs-libraries/integrations/social/instagram.provider';
import { InstagramStandaloneProvider } from '@gitroom/nestjs-libraries/integrations/social/instagram.standalone.provider';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function channel() {
  const state = { active: true };
  const disconnected = new Error('Channel is disconnected');
  const check = jest.fn(async () => {
    if (!state.active) throw disconnected;
  });
  return { state, check, disconnected };
}

const integration = {
  id: 'qa-channel', organizationId: 'qa-org', internalId: 'qa-ig-user',
  profile: 'qa_profile', token: 'qa-not-a-real-token',
} as Integration;

const providers = [
  { name: 'Instagram', create: () => new InstagramProvider(), domain: 'graph.facebook.com' },
  { name: 'Instagram Standalone', create: () => new InstagramStandaloneProvider(), domain: 'graph.instagram.com' },
];

describe('provider authorization after channel disconnection (no external I/O)', () => {
  let fetchMock: jest.SpiedFunction<typeof globalThis.fetch>;
  const timerMock = jest.mocked(timer);

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Unexpected mocked HTTP request');
    });
    timerMock.mockReset();
    timerMock.mockResolvedValue(undefined);
    jest.replaceProperty(process, 'env', {
      ...process.env,
      INSTAGRAM_APP_ID: 'qa-app-id',
      INSTAGRAM_APP_SECRET: 'qa-not-a-real-secret',
      FRONTEND_URL: 'https://example.invalid',
    });
  });

  afterEach(() => { jest.restoreAllMocks(); });

  test('an already disconnected channel cannot even enter the provider action', async () => {
    const current = channel();
    current.state.active = false;
    const action = jest.fn(() => providerFetch('https://example.invalid/never'));

    await expect(withProviderAuthorization(current.check, action)).rejects.toBe(current.disconnected);

    expect(action).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe.each(providers)('$name real publishing code', ({ create, domain }) => {
    test('disconnect while a story status request is in flight prevents media_publish', async () => {
      const current = channel();
      const entered = deferred();
      const statusResponse = deferred<Response>();
      fetchMock.mockImplementationOnce(() => {
        entered.resolve();
        return statusResponse.promise;
      });

      const operation = withProviderAuthorization(current.check, () => create().finalizePost(
        integration.token,
        { type: domain, postType: 'stories', containers: ['qa-story-container'] },
        integration
      ));
      await entered.promise;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain('/qa-story-container?');

      current.state.active = false;
      statusResponse.resolve(response({ status_code: 'FINISHED' }));

      await expect(operation).rejects.toBe(current.disconnected);
      expect(current.check).toHaveBeenCalledTimes(3); // entry, status, blocked publish
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/media_publish'))).toBe(false);
    });

    test('disconnect between stories prevents publishing the second story', async () => {
      const current = channel();
      const secondStatusStarted = deferred();
      const secondStatusResponse = deferred<Response>();
      fetchMock
        .mockResolvedValueOnce(response({ status_code: 'FINISHED' }))
        .mockResolvedValueOnce(response({ id: 'qa-live-story-one' }))
        .mockImplementationOnce(() => {
          secondStatusStarted.resolve();
          return secondStatusResponse.promise;
        });

      const operation = withProviderAuthorization(current.check, () => create().finalizePost(
        integration.token,
        { type: domain, postType: 'stories', containers: ['qa-container-one', 'qa-container-two'] },
        integration
      ));
      await secondStatusStarted.promise;
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(String(fetchMock.mock.calls[1][0])).toContain('/media_publish?creation_id=qa-container-one');
      expect(fetchMock.mock.calls[1][1]?.method).toBe('POST');
      expect(String(fetchMock.mock.calls[2][0])).toContain('/qa-container-two?');

      current.state.active = false;
      secondStatusResponse.resolve(response({ status_code: 'FINISHED' }));

      await expect(operation).rejects.toBe(current.disconnected);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/media_publish'))).toHaveLength(1);
    });

    test('legacy post polling cannot send the next status request after its wait', async () => {
      const current = channel();
      const waiting = deferred<number>();
      const resume = deferred();
      fetchMock
        .mockResolvedValueOnce(response({ id: 'qa-container' }))
        .mockResolvedValueOnce(response({ status_code: 'IN_PROGRESS' }));
      timerMock.mockImplementationOnce((ms) => {
        waiting.resolve(ms);
        return resume.promise;
      });

      const operation = withProviderAuthorization(current.check, () => create().post(
        integration.internalId, integration.token,
        [{ id: 'qa-post', message: 'QA only', settings: { post_type: 'post', collaborators: [] },
          media: [{ type: 'image', path: 'https://example.invalid/qa.jpg' }] }],
        integration
      ));
      expect(await waiting.promise).toBe(30000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[0][0])).toContain(`https://${domain}/v20.0/qa-ig-user/media?`);
      expect(String(fetchMock.mock.calls[1][0])).toContain('/qa-container?');

      current.state.active = false;
      resume.resolve();

      await expect(operation).rejects.toBe(current.disconnected);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(timerMock).toHaveBeenCalledTimes(1);
    });

    test('already sent media_publish is not undone, but no later permalink HTTP is sent', async () => {
      const current = channel();
      const publishStarted = deferred();
      const publishResponse = deferred<Response>();
      fetchMock.mockImplementationOnce(() => {
        publishStarted.resolve();
        return publishResponse.promise;
      });

      const operation = withProviderAuthorization(current.check, () => create().finalizePost(
        integration.token,
        { type: domain, postType: 'single', containers: ['qa-container'] },
        integration
      ));
      await publishStarted.promise;
      expect(String(fetchMock.mock.calls[0][0])).toContain('/media_publish?');
      current.state.active = false;
      publishResponse.resolve(response({ id: 'qa-already-published' }));

      // igPermalink deliberately catches errors for an already-live post.
      await expect(operation).resolves.toMatchObject({
        status: 'completed', postId: 'qa-already-published',
        releaseURL: 'https://www.instagram.com/qa_profile',
      });
      expect(current.check).toHaveBeenCalledTimes(3);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  test.each([
    { status: 429, message: 'Too many requests' },
    { status: 500, message: 'Temporary server failure' },
    { status: 400, message: 'An unknown error occurred' },
  ])('SocialAbstract retry after HTTP $status rechecks authorization before sending', async ({ status, message }) => {
    const current = channel();
    const waiting = deferred<number>();
    const resume = deferred();
    fetchMock.mockResolvedValueOnce(response({ error: { message } }, status));
    timerMock.mockImplementationOnce((ms) => {
      waiting.resolve(ms);
      return resume.promise;
    });

    const operation = withProviderAuthorization(current.check, () => new InstagramProvider().fetch(
      'https://graph.facebook.com/v20.0/qa-ig-user/media_publish', { method: 'POST' }
    ));
    expect(await waiting.promise).toBe(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    current.state.active = false;
    resume.resolve();

    await expect(operation).rejects.toBe(current.disconnected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(current.check).toHaveBeenCalledTimes(3);
  });

  test.each([
    { name: 'Instagram analytics', firstBody: { data: [] },
      run: () => new InstagramProvider().analytics('qa-ig-user', integration.token, 30) },
    { name: 'Standalone refresh', firstBody: { access_token: 'qa-refreshed-token' },
      run: () => new InstagramStandaloneProvider().refreshToken('qa-refresh-token') },
  ])('$name direct fetch alias blocks the next HTTP after disconnection', async ({ run, firstBody }) => {
    const current = channel();
    const entered = deferred();
    const firstResponse = deferred<Response>();
    fetchMock.mockImplementationOnce(() => {
      entered.resolve();
      return firstResponse.promise;
    });

    const operation = withProviderAuthorization<unknown>(current.check, run);
    await entered.promise;
    current.state.active = false;
    firstResponse.resolve(response(firstBody));

    await expect(operation).rejects.toBe(current.disconnected);
    expect(current.check).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('parallel async channel contexts remain isolated across interleaved waits', async () => {
    const a = channel();
    const b = channel();
    const startedA = deferred();
    const startedB = deferred();
    const resumeA = deferred();
    const resumeB = deferred();
    fetchMock.mockImplementation(async () => response({ ok: true }));

    const operationA = withProviderAuthorization(a.check, async () => {
      await providerFetch('https://example.invalid/a/first');
      startedA.resolve();
      await resumeA.promise;
      return providerFetch('https://example.invalid/a/second');
    });
    const operationB = withProviderAuthorization(b.check, async () => {
      await providerFetch('https://example.invalid/b/first');
      startedB.resolve();
      await resumeB.promise;
      return providerFetch('https://example.invalid/b/second');
    });
    await Promise.all([startedA.promise, startedB.promise]);
    a.state.active = false;
    resumeB.resolve();
    await expect(operationB).resolves.toBeInstanceOf(Response);
    resumeA.resolve();
    await expect(operationA).rejects.toBe(a.disconnected);

    expect(a.check).toHaveBeenCalledTimes(3);
    expect(b.check).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      'https://example.invalid/a/first',
      'https://example.invalid/b/first',
      'https://example.invalid/b/second',
    ]);
  });

  test('real standalone OAuth outside the context works while a disconnected operation is suspended', async () => {
    const current = channel();
    const entered = deferred();
    const resume = deferred();
    const suspended = withProviderAuthorization(current.check, async () => {
      entered.resolve();
      await resume.promise;
      return providerFetch('https://example.invalid/disconnected');
    });
    await entered.promise;
    current.state.active = false;

    const provider = new InstagramStandaloneProvider();
    fetchMock
      .mockResolvedValueOnce(response({ access_token: 'qa-short-token', permissions: provider.scopes }))
      .mockResolvedValueOnce(response({ access_token: 'qa-long-token', expires_in: 3600 }))
      .mockResolvedValueOnce(response({ user_id: 'qa-oauth-user', name: 'QA', username: 'qa_oauth' }));

    await expect(provider.authenticate({ code: 'qa-code', codeVerifier: 'qa-verifier', refresh: '' }))
      .resolves.toMatchObject({ id: 'qa-oauth-user', accessToken: 'qa-long-token', username: 'qa_oauth' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.instagram.com/oauth/access_token');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
    expect(current.check).toHaveBeenCalledTimes(1);

    resume.resolve();
    await expect(suspended).rejects.toBe(current.disconnected);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock.mockResolvedValueOnce(response({ ok: true }));
    await expect(providerFetch('https://example.invalid/outside-after-rejection')).resolves.toBeInstanceOf(Response);
    expect(current.check).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
