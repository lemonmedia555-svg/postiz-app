import { HttpException, HttpStatus } from '@nestjs/common';

// Keep all infrastructure outside this unit suite. The service and refresh
// service below are real implementations; neither is replaced by a mock.
jest.mock('@gitroom/nestjs-libraries/database/prisma/integrations/integration.repository', () => ({ IntegrationRepository: class {} }));
jest.mock('@gitroom/nestjs-libraries/database/prisma/autopost/autopost.repository', () => ({ AutopostRepository: class {} }));
jest.mock('@gitroom/nestjs-libraries/database/prisma/notifications/notification.service', () => ({ NotificationService: class {} }));
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({ IntegrationManager: class {} }));
jest.mock('@gitroom/nestjs-libraries/integrations/social.abstract', () => ({
  NotEnoughScopes: class {}, RefreshToken: class extends Error {},
}));
jest.mock('nestjs-temporal-core', () => ({ TemporalService: class {} }));
jest.mock('@gitroom/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: jest.fn(() => ({ removePublicFile: jest.fn(), uploadSimple: jest.fn() })) },
}));
jest.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: { set: jest.fn(), get: jest.fn(), scan: jest.fn(), del: jest.fn(), eval: jest.fn() },
}));

import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { providerFetch } from '@gitroom/nestjs-libraries/integrations/provider.authorization';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';

const redis = ioRedis as jest.Mocked<typeof ioRedis>;
const org = 'qa_org_a';
const channel = 'qa_channel_a';
const requestId = 'qa_removal_a';
const lockKey = `integration-removal-lock:${requestId}`;
const retryError = 'Cleanup requires retry or operator review';
const channelData = () => ({
  id: channel, organizationId: org, providerIdentifier: 'instagram-standalone',
  internalId: 'qa_provider_id', rootInternalId: 'qa_provider_id',
  token: 'qa-not-a-real-token', refreshToken: 'qa-not-a-real-refresh',
  disabled: false, deletedAt: null, authorizedAt: new Date('2026-09-01T00:00:00Z'),
});

describe('IntegrationService removal with isolated dependencies', () => {
  let service: IntegrationService;
  let repository: any;
  let manager: any;
  let temporal: any;
  let workflow: any;
  let receipt: any;
  let keys: Map<string, string>;
  let storage: any;

  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers();
    keys = new Map();
    receipt = {
      id: requestId, status: 'pending', attempts: 0, mode: 'disconnect', lastError: null,
      targets: [{ id: channel, org, picture: 'https://example.invalid/shared.png', posts: ['qa_post_a', 'qa_post_b'] }],
    };
    repository = {
      getIntegrationById: jest.fn(async () => channelData()),
      getRemoval: jest.fn(async () => null),
      getIntegrationsList: jest.fn(async () => []),
      getPendingAuthorizationRemovals: jest.fn(async () => []),
      beginAccountDeletionFence: jest.fn(async () => ({})),
      finishAccountDeletionFence: jest.fn(async () => ({})),
      beginRemoval: jest.fn(async () => receipt),
      getRemovalById: jest.fn(async () => ({ ...receipt })),
      claimRemovalAttempt: jest.fn(async () => {
        if (receipt.status !== 'pending' || receipt.attempts >= 3) return { count: 0 };
        receipt.attempts++;
        return { count: 1 };
      }),
      eraseChannelRecords: jest.fn(async () => ['qa_post_a', 'qa_post_c']),
      updateRemoval: jest.fn(async (_id, patch) => {
        if (receipt.status !== 'pending') return { count: 0 };
        Object.assign(receipt, patch);
        return { count: 1 };
      }),
      pendingRemovals: jest.fn(async () => [{ id: requestId }]),
      updateRefreshedCredentials: jest.fn(async () => ({ count: 1 })),
      refreshNeeded: jest.fn(),
      disconnectChannel: jest.fn(),
    };
    redis.set.mockImplementation(async (key: any, value: any) => {
      if (keys.has(key)) return null;
      keys.set(key, value);
      return 'OK';
    });
    redis.get.mockImplementation(async (key: any) => keys.get(key) ?? null);
    redis.scan.mockResolvedValue(['0', []]);
    redis.del.mockImplementation(async (...names: any[]) => names.reduce((count, name) => count + Number(keys.delete(name)), 0));
    redis.eval.mockImplementation(async (script: any, _number: any, key: any, value: any) => {
      if (keys.get(key) !== value) return 0;
      if (script.includes('"del"')) keys.delete(key);
      return 1;
    });
    workflow = {
      list: jest.fn(() => (async function* () {})()),
      getHandle: jest.fn(() => ({ terminate: jest.fn(async () => undefined) })),
    };
    temporal = { client: { getRawClient: jest.fn(() => ({ workflow })) } };
    manager = { getSocialIntegration: jest.fn(), getInternalPlugs: jest.fn() };
    storage = { removePublicFile: jest.fn(), uploadSimple: jest.fn() };
    (UploadFactory.createStorage as jest.Mock).mockReturnValue(storage);
    service = new IntegrationService(repository, {} as any, manager, {} as any, {} as any, temporal);
  });

  afterEach(() => {
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  const expectPending = (getReceipt: () => any, getRepository: () => any) => {
    expect(getReceipt()).toMatchObject({ status: 'pending', lastError: retryError });
    expect(getRepository().updateRemoval).toHaveBeenCalledWith(requestId, { lastError: retryError });
    expect(getRepository().updateRemoval.mock.calls.every(([, patch]: any[]) => !('status' in patch))).toBe(true);
  };

  test('deleteChannel reports 503, not success, when cleanup remains pending', async () => {
    temporal.client.getRawClient.mockReturnValue(null);
    const error = await service.deleteChannel(org, channel).catch(err => err);
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(error.message).toContain(requestId);
    expect(repository.beginRemoval).toHaveBeenCalledWith(`channel:${channel}`, 'disconnect', [channelData()]);
    expectPending(() => receipt, () => repository);
    expect(repository.eraseChannelRecords).not.toHaveBeenCalled();
    expect(keys.has(lockKey)).toBe(false);
  });

  test('deleteChannel returns access-only status without claiming authorization or file erasure', async () => {
    await expect(service.deleteChannel(org, channel)).resolves.toEqual({
      success: true, status: 'disconnected', authorizationRevoked: false,
      erasurePendingReview: true, requestId,
    });
    expect(receipt.status).toBe('disconnected');
    expect(storage.removePublicFile).not.toHaveBeenCalled();
    expect(receipt.targets[0].picture).toBe('https://example.invalid/shared.png');
  });

  test('disconnecting a Google grant revokes every linked channel before erasing either one', async () => {
    const second = { ...channelData(), id: 'qa_channel_b', organizationId: 'qa_org_b',
      providerIdentifier: 'youtube', rootInternalId: 'qa_google_user' };
    const first = { ...channelData(), providerIdentifier: 'youtube', rootInternalId: 'qa_google_user' };
    const revokeAuthorization = jest.fn(async () => undefined);
    manager.getSocialIntegration.mockReturnValue({
      authorizationGroup: (item: any) => item.rootInternalId,
      revokeAuthorization,
    });
    repository.getIntegrationById.mockImplementation(async (targetOrg: string, targetId: string) =>
      targetOrg === org && targetId === channel ? first : second);
    receipt.targets = [
      { id: channel, org, posts: [], providerIdentifier: 'youtube', revokeAuthorization: true },
      { id: second.id, org: second.organizationId, posts: [], providerIdentifier: 'youtube', revokeAuthorization: true },
    ];

    await expect(service.deleteChannel(org, channel)).resolves.toMatchObject({
      authorizationRevoked: true, affectedChannels: 2, status: 'disconnected',
    });
    expect(repository.beginRemoval).toHaveBeenCalledWith(expect.stringMatching(/^grant:/),
      'disconnect', [first], undefined, {
        providerIdentifier: 'youtube', rootInternalId: 'qa_google_user', revokeAuthorization: true,
      });
    expect(revokeAuthorization).toHaveBeenCalledTimes(2);
    expect(Math.max(...revokeAuthorization.mock.invocationCallOrder))
      .toBeLessThan(Math.min(...repository.eraseChannelRecords.mock.invocationCallOrder));
  });

  test('a failed Google revoke leaves the whole group disabled and pending for retry', async () => {
    const first = { ...channelData(), providerIdentifier: 'youtube', rootInternalId: 'qa_google_user' };
    manager.getSocialIntegration.mockReturnValue({
      authorizationGroup: (item: any) => item.rootInternalId,
      revokeAuthorization: jest.fn(async () => { throw new Error('qa-provider-token-secret'); }),
    });
    repository.getIntegrationById.mockResolvedValue(first);
    receipt.targets = [{ id: channel, org, posts: [], providerIdentifier: 'youtube', revokeAuthorization: true }];
    const error = await service.deleteChannel(org, channel).catch(err => err);
    expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(repository.eraseChannelRecords).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({ status: 'pending', lastError: retryError });
    expect(JSON.stringify(repository.updateRemoval.mock.calls)).not.toContain('qa-provider-token-secret');
  });

  test('account deletion commits its OAuth fence before selecting channels', async () => {
    receipt.mode = 'data-deletion';
    await service.deleteChannelsForAccount(org);
    expect(repository.beginAccountDeletionFence).toHaveBeenCalledWith(org);
    expect(repository.getIntegrationsList).toHaveBeenCalledWith(org);
    expect(repository.beginAccountDeletionFence.mock.invocationCallOrder[0])
      .toBeLessThan(repository.getIntegrationsList.mock.invocationCallOrder[0]);
    expect(repository.beginRemoval).toHaveBeenCalledWith(`account:${org}`, 'data-deletion', [], org);
    expect(repository.finishAccountDeletionFence).not.toHaveBeenCalled();
  });

  test('deleteChannel reuses the durable request rather than widening its targets', async () => {
    repository.getRemoval.mockResolvedValue(receipt);
    await service.deleteChannel(org, channel);
    expect(repository.beginRemoval).not.toHaveBeenCalled();
    expect(repository.eraseChannelRecords).toHaveBeenCalledTimes(1);
    expect(repository.eraseChannelRecords).toHaveBeenCalledWith(org, channel);
  });

  test('unknown channel returns 404 before cleanup starts', async () => {
    repository.getIntegrationById.mockResolvedValue(null);
    const error = await service.deleteChannel(org, channel).catch(err => err);
    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(repository.beginRemoval).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  test('stops only the target refresh workflow and exact receipt post IDs, including every run', async () => {
    const queries = [
      `WorkflowId="refresh_${channel}" AND ExecutionStatus="Running"`,
      'postId="qa_post_a" AND ExecutionStatus="Running"',
      'postId="qa_post_b" AND ExecutionStatus="Running"',
    ];
    const executions = queries.map((query, index) => ({ query, workflowId: `qa_workflow_${index}`, runId: `qa_run_${index}` }));
    executions.push({ query: queries[1], workflowId: 'qa_workflow_second_run', runId: 'qa_run_second' });
    const terminate = jest.fn(async () => undefined);
    workflow.list.mockImplementation(({ query }: { query: string }) => (async function* () {
      for (const execution of executions.filter(item => item.query === query)) yield execution;
    })());
    workflow.getHandle.mockReturnValue({ terminate });
    await service.processRemoval(requestId);
    expect(workflow.list.mock.calls.map(([argument]: any[]) => argument)).toEqual(queries.map(query => ({ query })));
    expect(workflow.getHandle.mock.calls).toEqual([
      ['qa_workflow_0', 'qa_run_0'], ['qa_workflow_1', 'qa_run_1'],
      ['qa_workflow_second_run', 'qa_run_second'], ['qa_workflow_2', 'qa_run_2'],
    ]);
    expect(terminate).toHaveBeenCalledTimes(4);
    expect(terminate.mock.calls.every(([reason]) => reason === 'Channel removed')).toBe(true);
    expect(Math.max(...terminate.mock.invocationCallOrder)).toBeLessThan(repository.eraseChannelRecords.mock.invocationCallOrder[0]);
  });

  test('clears channel and post analytics families with all SCAN pages, preserving unrelated keys', async () => {
    const channelPage1 = `integration:${org}:${channel}:30`;
    const channelPage2 = `integration:${org}:${channel}:90`;
    const postA = `integration:${org}:qa_post_a:30`;
    const postC = `integration:${org}:qa_post_c:90`;
    const protectedKeys = [`integration:qa_org_b:${channel}:30`, `integration:${org}:qa_other_channel:30`];
    [channelPage1, channelPage2, postA, postC, ...protectedKeys].forEach(key => keys.set(key, 'qa-cache'));
    redis.scan.mockImplementation(async (cursor: any, _match: any, pattern: any) => {
      if (pattern === `integration:${org}:${channel}:*`) return cursor === '0' ? ['17', [channelPage1]] : ['0', [channelPage2]];
      if (pattern === `integration:${org}:qa_post_a:*`) return ['0', [postA]];
      if (pattern === `integration:${org}:qa_post_c:*`) return ['0', [postC]];
      return ['0', []];
    });
    await service.processRemoval(requestId);
    expect(redis.scan.mock.calls).toEqual([
      ['0', 'MATCH', `integration:${org}:${channel}:*`, 'COUNT', 100],
      ['17', 'MATCH', `integration:${org}:${channel}:*`, 'COUNT', 100],
      ['0', 'MATCH', `integration:${org}:qa_post_a:*`, 'COUNT', 100],
      ['0', 'MATCH', `integration:${org}:qa_post_b:*`, 'COUNT', 100],
      ['0', 'MATCH', `integration:${org}:qa_post_c:*`, 'COUNT', 100],
    ]);
    expect(redis.del.mock.calls).toEqual([[channelPage1], [channelPage2], [postA], [postC]]);
    expect([...keys.keys()]).toEqual(protectedKeys);
    expect(receipt.status).toBe('disconnected');
  });

  test.each(['data-deletion', 'deauthorize'])('%s remains explicitly pending operator erasure review', async mode => {
    receipt.mode = mode;
    await service.processRemoval(requestId);
    expect(receipt).toMatchObject({ status: 'active_data_deleted_pending_review', lastError: null });
    expect(receipt.targets[0].picture).toBe('https://example.invalid/shared.png');
    expect(storage.removePublicFile).not.toHaveBeenCalled();
  });

  test.each(['queue', 'list', 'terminate', 'database', 'scan', 'cache-delete', 'lease-read', 'receipt-save'])('%s failure never completes and stores no provider exception details', async stage => {
    const error = new Error('https://example.invalid/?access_token=qa-sensitive-fixture');
    if (stage === 'queue') temporal.client.getRawClient.mockImplementation(() => { throw error; });
    if (stage === 'list') workflow.list.mockImplementation(() => (async function* () { throw error; })());
    if (stage === 'terminate') {
      workflow.list.mockImplementation(() => (async function* () { yield { workflowId: 'qa_workflow', runId: 'qa_run' }; })());
      workflow.getHandle.mockReturnValue({ terminate: jest.fn(async () => { throw error; }) });
    }
    if (stage === 'database') repository.eraseChannelRecords.mockRejectedValue(error);
    if (stage === 'scan') redis.scan.mockRejectedValue(error);
    if (stage === 'cache-delete') {
      redis.scan.mockResolvedValue(['0', ['qa-key']]);
      redis.del.mockRejectedValue(error);
    }
    if (stage === 'lease-read') redis.get.mockRejectedValue(error);
    if (stage === 'receipt-save') repository.updateRemoval.mockRejectedValueOnce(error);
    await service.processRemoval(requestId);
    if (stage === 'receipt-save') {
      expect(receipt).toMatchObject({ status: 'pending', lastError: retryError });
      expect(repository.updateRemoval).toHaveBeenLastCalledWith(requestId, { lastError: retryError });
    } else expectPending(() => receipt, () => repository);
    expect(JSON.stringify(repository.updateRemoval.mock.calls)).not.toContain('qa-sensitive-fixture');
    expect(keys.has(lockKey)).toBe(false);
  });

  test('an already-finished Temporal run is safe to ignore', async () => {
    workflow.list.mockImplementation(() => (async function* () { yield { workflowId: 'qa_workflow', runId: 'qa_run' }; })());
    workflow.getHandle.mockReturnValue({ terminate: jest.fn(async () => {
      throw Object.assign(new Error('already gone'), { name: 'WorkflowNotFoundError' });
    }) });
    await service.processRemoval(requestId);
    expect(receipt.status).toBe('disconnected');
  });

  test('stops after three claimed failures, including retries through the cron entry point', async () => {
    temporal.client.getRawClient.mockReturnValue(null);
    for (let attempt = 0; attempt < 5; attempt++) await service.retryPendingRemovals();
    expect(receipt).toMatchObject({ attempts: 3, status: 'pending' });
    expect(repository.claimRemovalAttempt).toHaveBeenCalledTimes(3);
    expect(temporal.client.getRawClient).toHaveBeenCalledTimes(3);
    expect(repository.updateRemoval).toHaveBeenCalledTimes(3);
    expect(repository.eraseChannelRecords).not.toHaveBeenCalled();
  });

  test.each([null, { status: 'disconnected', attempts: 0 }, { status: 'pending', attempts: 3 }])('does not run an ineligible receipt: %j', async stored => {
    repository.getRemovalById.mockResolvedValue(stored);
    await service.processRemoval(requestId);
    expect(repository.claimRemovalAttempt).not.toHaveBeenCalled();
    expect(workflow.list).not.toHaveBeenCalled();
    expect(repository.updateRemoval).not.toHaveBeenCalled();
    expect(keys.has(lockKey)).toBe(false);
  });

  test('an unsuccessful atomic attempt claim does no cleanup', async () => {
    repository.claimRemovalAttempt.mockResolvedValue({ count: 0 });
    await service.processRemoval(requestId);
    expect(workflow.list).not.toHaveBeenCalled();
    expect(repository.eraseChannelRecords).not.toHaveBeenCalled();
    expect(repository.updateRemoval).not.toHaveBeenCalled();
  });

  test('an existing lease prevents another worker from claiming or deleting its lock', async () => {
    keys.set(lockKey, 'qa-other-worker');
    await service.processRemoval(requestId);
    expect(redis.set).toHaveBeenCalledWith(lockKey, expect.any(String), 'EX', 300, 'NX');
    expect(repository.getRemovalById).not.toHaveBeenCalled();
    expect(repository.claimRemovalAttempt).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
    expect(keys.get(lockKey)).toBe('qa-other-worker');
  });

  test('a replaced lease cannot produce success or delete its new owner', async () => {
    repository.eraseChannelRecords.mockImplementation(async () => {
      keys.set(lockKey, 'qa-new-owner');
      return [];
    });
    await service.processRemoval(requestId);
    expectPending(() => receipt, () => repository);
    expect(keys.get(lockKey)).toBe('qa-new-owner');
  });

  test.each(['lost', 'error'])('lease renewal %s cannot produce success even if the final key still matches', async mode => {
    const originalEval = redis.eval.getMockImplementation()!;
    redis.eval.mockImplementation(async (...args: any[]) => {
      if (String(args[0]).includes('"expire"')) {
        if (mode === 'error') throw new Error('qa Redis unavailable');
        return 0;
      }
      return (originalEval as any)(...args);
    });
    repository.eraseChannelRecords.mockImplementation(async () => {
      await jest.advanceTimersByTimeAsync(30000);
      return [];
    });
    await service.processRemoval(requestId);
    expectPending(() => receipt, () => repository);
    expect(redis.eval).toHaveBeenCalledWith(expect.stringContaining('"expire"'), 1, lockKey, expect.any(String));
    expect(keys.has(lockKey)).toBe(false);
  });

  test.each(['qa_channel" OR ExecutionStatus="Running', 'qa_post" OR postId="other'])('rejects an unsafe workflow query target: %s', async invalid => {
    if (invalid.startsWith('qa_channel')) receipt.targets[0].id = invalid;
    else receipt.targets[0].posts = [invalid];
    await service.processRemoval(requestId);
    expectPending(() => receipt, () => repository);
    expect(workflow.list).not.toHaveBeenCalled();
    expect(repository.eraseChannelRecords).not.toHaveBeenCalled();
  });

  test.each([null, { deletedAt: new Date() }, { disabled: true }, { token: '' }])('assertActive rejects a stale channel: %j', async changes => {
    repository.getIntegrationById.mockResolvedValue(changes ? { ...channelData(), ...changes } : null);
    const error = await service.assertActive(channelData() as any).catch(err => err);
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(HttpStatus.GONE);
    expect(repository.getIntegrationById).toHaveBeenCalledWith(org, channel);
  });

  test('refresh guard stops a removed channel before contacting its provider', async () => {
    repository.getIntegrationById.mockResolvedValue({ ...channelData(), deletedAt: new Date(), token: '' });
    const provider = { refreshToken: jest.fn() };
    manager.getSocialIntegration.mockReturnValue(provider);
    const refresh = new RefreshIntegrationService(manager, service, temporal);
    await expect(refresh.refresh(channelData() as any)).resolves.toBe(false);
    expect(manager.getSocialIntegration).not.toHaveBeenCalled();
    expect(provider.refreshToken).not.toHaveBeenCalled();
    expect(repository.updateRefreshedCredentials).not.toHaveBeenCalled();
  });

  test('late refresh whose credential save loses the race is not reported as refreshed', async () => {
    const result = { accessToken: 'qa-new-token', refreshToken: 'qa-new-refresh', expiresIn: 3600 };
    const provider = { refreshToken: jest.fn(async () => result), oneTimeToken: true };
    manager.getSocialIntegration.mockReturnValue(provider);
    repository.updateRefreshedCredentials.mockResolvedValue({ count: 0 });
    const refresh = new RefreshIntegrationService(manager, service, temporal);
    await expect(refresh.refresh(channelData() as any)).resolves.toBe(false);
    expect(provider.refreshToken).toHaveBeenCalledWith('qa-not-a-real-refresh');
    expect(repository.updateRefreshedCredentials).toHaveBeenCalledWith(channelData(), result.accessToken, result.refreshToken, 3600, true);
  });

  test('removal between initial refresh lookup and the invocation guard returns false without contacting the provider', async () => {
    repository.getIntegrationById.mockResolvedValueOnce(channelData()).mockResolvedValue(null);
    const provider = { refreshToken: jest.fn() };
    manager.getSocialIntegration.mockReturnValue(provider);
    const refresh = new RefreshIntegrationService(manager, service, temporal);
    await expect(refresh.refresh(channelData() as any)).resolves.toBe(false);
    expect(provider.refreshToken).not.toHaveBeenCalled();
    expect(repository.updateRefreshedCredentials).not.toHaveBeenCalled();
    expect(repository.disconnectChannel).not.toHaveBeenCalled();
  });

  test('unexpected authorization lookup errors are not hidden as a successful refresh', async () => {
    const error = new Error('qa database unavailable');
    repository.getIntegrationById.mockResolvedValueOnce(channelData()).mockRejectedValue(error);
    const provider = { refreshToken: jest.fn() };
    manager.getSocialIntegration.mockReturnValue(provider);
    const refresh = new RefreshIntegrationService(manager, service, temporal);
    await expect(refresh.refresh(channelData() as any)).rejects.toBe(error);
    expect(provider.refreshToken).not.toHaveBeenCalled();
    expect(repository.updateRefreshedCredentials).not.toHaveBeenCalled();
  });

  test('failed provider refresh after removal does not re-disconnect or notify the erased channel', async () => {
    const provider = { refreshToken: jest.fn(async () => {
      repository.getIntegrationById.mockResolvedValue(null);
      throw new Error('qa-provider-failed');
    }) };
    manager.getSocialIntegration.mockReturnValue(provider);
    const notify = jest.spyOn(service, 'informAboutRefreshError');
    const refresh = new RefreshIntegrationService(manager, service, temporal);
    await expect(refresh.refresh(channelData() as any)).resolves.toBe(false);
    expect(provider.refreshToken).toHaveBeenCalledTimes(1);
    expect(repository.refreshNeeded).not.toHaveBeenCalled();
    expect(repository.disconnectChannel).not.toHaveBeenCalled();
    expect(repository.updateRefreshedCredentials).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  test('withActiveIntegration refuses a stale action before it starts', async () => {
    repository.getIntegrationById.mockResolvedValue(null);
    const action = jest.fn(async () => 'must not run');
    await expect(service.withActiveIntegration(channelData(), action)).rejects.toThrow('Channel is disconnected');
    expect(action).not.toHaveBeenCalled();
  });

  test('a provider invocation re-checks authorization before each HTTP request', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
    try {
      await expect(service.withActiveIntegration(channelData(), async () => {
        await providerFetch('https://example.invalid/qa-first');
        repository.getIntegrationById.mockResolvedValue(null);
        await providerFetch('https://example.invalid/qa-after-removal');
      })).rejects.toThrow('Channel is disconnected');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith('https://example.invalid/qa-first', undefined);
      expect(repository.getIntegrationById).toHaveBeenCalledTimes(3);
    } finally {
      fetch.mockRestore();
    }
  });

  test('concurrent provider invocations keep authorization scoped to their own channel', async () => {
    const otherChannel = { ...channelData(), id: 'qa_channel_b', organizationId: 'qa_org_b' };
    let removed = false;
    repository.getIntegrationById.mockImplementation(async (orgId: string, id: string) => {
      if (orgId === otherChannel.organizationId && id === otherChannel.id) return otherChannel;
      return removed ? null : channelData();
    });
    let resumeFirst!: () => void;
    const firstStarted = new Promise<void>(resolve => { resumeFirst = resolve; });
    let allowFirstRequest!: () => void;
    const allowFirst = new Promise<void>(resolve => { allowFirstRequest = resolve; });
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
    try {
      const first = service.withActiveIntegration(channelData(), async () => {
        resumeFirst();
        await allowFirst;
        return providerFetch('https://example.invalid/qa-removed');
      }).catch(error => error);
      await firstStarted;
      await service.withActiveIntegration(otherChannel, async () => {
        removed = true;
        await providerFetch('https://example.invalid/qa-protected');
        allowFirstRequest();
      });
      expect(await first).toBeInstanceOf(HttpException);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith('https://example.invalid/qa-protected', undefined);
    } finally {
      allowFirstRequest();
      fetch.mockRestore();
    }
  });
});
