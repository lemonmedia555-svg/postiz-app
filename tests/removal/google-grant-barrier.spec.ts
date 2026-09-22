jest.mock('@gitroom/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: () => ({}) },
}));

import { GrantClosedDuringConnection, IntegrationRepository } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.repository';

describe('Google grant write barrier', () => {
  const removedAt = new Date('2026-09-22T12:00:00Z');
  let db: any;
  let repository: IntegrationRepository;

  beforeEach(() => {
    db = {
      $queryRaw: jest.fn(async () => [{ locked: 1 }]),
      integrationRemoval: { findFirst: jest.fn(async () => null) },
      organization: { updateMany: jest.fn(async () => ({ count: 1 })) },
      integration: { upsert: jest.fn(async () => ({ id: 'qa_channel' })),
        findFirst: jest.fn(async () => null) },
    };
    const model = { model: db } as any;
    const transaction = { model: { $transaction: async (fn: (tx: any) => Promise<any>) => fn(db) } } as any;
    repository = new IntegrationRepository(model, model, model, model, model, model, transaction, model);
  });

  const connect = (repository: IntegrationRepository, startedAt: Date,
    verifyAuthorization?: () => Promise<void>) =>
    repository.createOrUpdateIntegration(
      undefined, false, 'qa_org', 'QA channel', undefined, 'social',
      'qa_google_user', 'youtube', 'qa-access-token', 'qa-refresh-token',
      3600, undefined, true, undefined, undefined, undefined, startedAt, verifyAuthorization
    );

  test('an OAuth callback already in flight cannot save a token after grant removal', async () => {
    db.integrationRemoval.findFirst.mockResolvedValue({ status: 'disconnected', createdAt: removedAt });
    await expect(connect(repository, new Date('2026-09-22T11:59:59Z')))
      .rejects.toBeInstanceOf(GrantClosedDuringConnection);
    expect(db.integration.upsert).not.toHaveBeenCalled();
  });

  test('a new OAuth callback after completed removal can reconnect', async () => {
    db.integrationRemoval.findFirst.mockResolvedValue(null);
    await expect(connect(repository, new Date('2026-09-22T12:00:01Z')))
      .resolves.toMatchObject({ id: 'qa_channel' });
    expect(db.integration.upsert).toHaveBeenCalledTimes(1);
  });

  test('pending revocation blocks every callback for the grant', async () => {
    db.integrationRemoval.findFirst.mockResolvedValue({ status: 'pending', createdAt: removedAt });
    await expect(connect(repository, new Date('2026-09-22T12:00:01Z')))
      .rejects.toBeInstanceOf(GrantClosedDuringConnection);
    expect(db.integration.upsert).not.toHaveBeenCalled();
  });

  test('a token revoked while the callback waited is refused before saving', async () => {
    const verifyAuthorization = jest.fn(async () => { throw new Error('revoked token'); });
    await expect(connect(repository, new Date('2026-09-22T12:00:01Z'), verifyAuthorization))
      .rejects.toThrow('revoked token');
    expect(db.integration.upsert).not.toHaveBeenCalled();
  });

  test('reconnected channel uses Google account root for the grant barrier', async () => {
    await repository.createOrUpdateIntegration(
      undefined, false, 'qa_org', 'QA channel', undefined, 'social',
      'qa_channel_id', 'youtube', 'qa-access-token', 'qa-refresh-token',
      3600, undefined, true, 'qa_channel_id', undefined, undefined,
      new Date('2026-09-22T12:00:01Z'), undefined, 'qa_google_user'
    );
    expect(db.integrationRemoval.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ scope: { startsWith: expect.stringMatching(/^grant:/) } }),
    }));
    expect(db.integration.upsert.mock.calls[0][0].create.rootInternalId).toBe('qa_google_user');
  });
});
