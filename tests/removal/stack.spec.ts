import { PrismaClient } from '@prisma/client';
import { Client, Connection } from '@temporalio/client';

jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({ IntegrationManager: class {} }));
jest.mock('@gitroom/nestjs-libraries/database/prisma/notifications/notification.service', () => ({ NotificationService: class {} }));
jest.mock('@gitroom/nestjs-libraries/upload/upload.factory', () => ({ UploadFactory: { createStorage: () => ({}) } }));
import { IntegrationRepository } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.repository';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

const suite = process.env.REMOVAL_QA === '1' ? describe : describe.skip;
suite('isolated PostgreSQL + Redis + Temporal removal stack', () => {
  let db: PrismaClient;
  let connection: Connection;
  let client: Client;
  let repo: IntegrationRepository;
  let service: IntegrationService;
  let counter = 0;
  const org = 'removal_qa_stack_org';
  const handles: Array<ReturnType<Client['workflow']['getHandle']>> = [];

  beforeAll(async () => {
    if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/creatu_removal_qa') ||
        !process.env.REDIS_URL?.includes('creatu-removal-qa-redis') ||
        !process.env.REMOVAL_QA_TEMPORAL?.startsWith('creatu-removal-qa-temporal:')) {
      throw new Error('Only the isolated QA services are permitted');
    }
    db = new PrismaClient();
    await db.$connect();
    connection = await Connection.connect({ address: process.env.REMOVAL_QA_TEMPORAL });
    client = new Client({ connection });
    const model = { model: db } as any;
    repo = new IntegrationRepository(model, model, model, model, model, model, model, model);
    service = new IntegrationService(repo, {} as any, {} as any, {} as any, {} as any,
      { client: { getRawClient: () => client } } as any);
    await db.organization.upsert({ where: { id: org }, create: { id: org, name: 'Synthetic removal stack' }, update: {} });
  });

  afterAll(async () => {
    for (const handle of handles) await handle.terminate('QA finished').catch(() => undefined);
    await connection?.close();
    await db?.$disconnect();
    if (process.env.REMOVAL_QA === '1') await ioRedis.quit();
  });

  async function fixture() {
    const id = `removal_qa_stack_${Date.now()}_${++counter}`;
    const integration = await db.integration.create({ data: { id, organizationId: org,
      providerIdentifier: 'instagram-standalone', internalId: id, rootInternalId: id,
      name: 'Synthetic QA only', type: 'social', token: 'qa-not-a-real-token',
      refreshToken: 'qa-not-a-real-refresh', picture: 'https://example.invalid/shared-avatar.png' } });
    const post = await db.post.create({ data: { id: `${id}_post`, organizationId: org,
      integrationId: id, content: 'Synthetic content', group: id, publishDate: new Date(),
      releaseURL: 'https://example.invalid/result', releaseId: 'qa-result' } });
    return { integration, post };
  }

  async function start(id: string, postId?: string) {
    const handle = await client.workflow.start('syntheticNoWorkerWorkflow', {
      workflowId: id, taskQueue: 'removal-qa-no-workers', workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      ...(postId ? { searchAttributes: { postId: [postId] } } : {}),
    });
    handles.push(handle);
    return handle;
  }

  test('stops the exact running jobs and both cache families, leaves unrelated jobs/cache intact', async () => {
    const { integration, post } = await fixture();
    const refresh = await start(`refresh_${integration.id}`);
    const publish = await start(`qa_publish_${post.id}`, post.id);
    const unrelated = await start(`qa_protected_${post.id}`, `${post.id}_other`);
    const keys = [`integration:${org}:${integration.id}:7`, `integration:${org}:${post.id}:7`];
    for (const key of [...keys, `integration:${org}:protected:7`]) await ioRedis.set(key, 'QA');
    const result = await service.deleteChannel(org, integration.id);
    expect(result).toMatchObject({ status: 'disconnected', authorizationRevoked: false, erasurePendingReview: true });
    expect((await refresh.describe()).status.name).toBe('TERMINATED');
    expect((await publish.describe()).status.name).toBe('TERMINATED');
    expect((await unrelated.describe()).status.name).toBe('RUNNING');
    for (const key of keys) expect(await ioRedis.get(key)).toBeNull();
    expect(await ioRedis.get(`integration:${org}:protected:7`)).toBe('QA');
    expect(await db.integration.findUnique({ where: { id: integration.id } })).toMatchObject({ token: '', picture: null, profile: null });
    expect(await db.post.findUnique({ where: { id: post.id } })).toMatchObject({ content: '', releaseURL: null, image: null });
    const receipt = await repo.getRemoval(`channel:${integration.id}`);
    expect((receipt!.targets as any[])[0].picture).toBe('https://example.invalid/shared-avatar.png');
  });

  test('queue failure blocks success, removes keys first and can be retried without expanding targets', async () => {
    const { integration } = await fixture();
    const unavailable = new IntegrationService(repo, {} as any, {} as any, {} as any, {} as any,
      { client: { getRawClient: () => undefined } } as any);
    await expect(unavailable.deleteChannel(org, integration.id)).rejects.toThrow('cleanup is pending');
    expect((await db.integration.findUnique({ where: { id: integration.id } }))!.token).toBe('');
    const pending = (await repo.getRemoval(`channel:${integration.id}`))!;
    expect(pending).toMatchObject({ status: 'pending', attempts: 1 });
    await service.processRemoval(pending.id);
    expect(await repo.getRemovalById(pending.id)).toMatchObject({ status: 'disconnected', attempts: 2, targets: pending.targets });
  });

  test('Redis cleanup error is pending, not completed; recovery succeeds', async () => {
    const { integration } = await fixture();
    const scan = jest.spyOn(ioRedis, 'scan').mockRejectedValueOnce(new Error('synthetic redis failure') as never);
    try { await expect(service.deleteChannel(org, integration.id)).rejects.toThrow('cleanup is pending'); }
    finally { scan.mockRestore(); }
    const receipt = (await repo.getRemoval(`channel:${integration.id}`))!;
    expect(receipt.status).toBe('pending');
    expect(receipt.lastError).not.toContain('synthetic redis failure');
    await service.processRemoval(receipt.id);
    expect((await repo.getRemovalById(receipt.id))!.status).toBe('disconnected');
  });

  test('Meta data-deletion stays review-pending and duplicate callback reuses its durable receipt', async () => {
    const { integration } = await fixture();
    const issued = Math.ceil(Date.now() / 1000);
    const first = await service.eraseInstagramStandaloneData(integration.internalId, true, issued);
    const second = await service.eraseInstagramStandaloneData(integration.internalId, true, issued);
    expect(second!.id).toBe(first!.id);
    expect(first!.status).toBe('active_data_deleted_pending_review');
    expect(first!.status).not.toBe('completed');
  });
});
