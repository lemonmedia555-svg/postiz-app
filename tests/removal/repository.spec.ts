import { PrismaClient, CreationMethod } from '@prisma/client';
import { createHash } from 'crypto';

jest.mock('@gitroom/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: () => ({}) },
}));
import { IntegrationRepository } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.repository';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';

const enabled = process.env.REMOVAL_QA === '1';
const suite = enabled ? describe : describe.skip;
suite('isolated PostgreSQL removal integration', () => {
  let db: PrismaClient;
  let integrations: IntegrationRepository;
  let posts: PostsRepository;
  const orgA = 'removal_qa_org_a';
  const orgB = 'removal_qa_org_b';
  const ig = 'removal_qa_instagram';
  const other = 'removal_qa_protected';
  const platformId = '990000000000001';
  const newChannel = (id: string, organizationId: string, providerIdentifier = 'instagram-standalone', internalId = platformId) => ({
    id, organizationId, providerIdentifier, internalId, rootInternalId: internalId,
    name: 'QA fixture', profile: 'qa_profile', type: 'social', token: 'qa-not-a-real-token',
    refreshToken: 'qa-not-a-real-refresh', picture: null,
  });
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!url.pathname.startsWith('/creatu_removal_qa')) throw new Error('Refusing a non-QA database');
    db = new PrismaClient();
    await db.$connect();
    const model = { model: db } as any;
    integrations = new IntegrationRepository(model, model, model, model, model, model, model, model);
    posts = new PostsRepository(model, model, model, model, model, model, model);
  });
  beforeEach(async () => {
    // Only the explicitly isolated, empty QA database is used by this suite.
    await db.errors.deleteMany(); await db.comments.deleteMany(); await db.tagsPosts.deleteMany();
    await db.post.deleteMany(); await db.media.deleteMany(); await db.integrationRemoval.deleteMany();
    await db.integration.deleteMany(); await db.organization.deleteMany();
    await db.organization.createMany({ data: [{ id: orgA, name: 'QA A' }, { id: orgB, name: 'QA B' }] });
    await db.integration.createMany({ data: [newChannel(ig, orgA), newChannel(other, orgB, 'vk', '990000000000002')] });
    await db.post.createMany({ data: [
      { id: 'removal_qa_post_a', organizationId: orgA, integrationId: ig, content: 'QA content to erase',
        group: 'same-group-for-isolation-test', publishDate: new Date(), releaseURL: 'https://example.invalid/qa', releaseId: 'qa-release', image: '["qa-image"]', settings: '{"qa":true}', error: 'qa-error' },
      { id: 'removal_qa_post_b', organizationId: orgB, integrationId: other, content: 'Protected content',
        group: 'same-group-for-isolation-test', publishDate: new Date() },
    ] });
  });
  afterAll(async () => { await db?.$disconnect(); });

  test('barrier erases credentials atomically with a durable receipt; preserves other org', async () => {
    const protectedBefore = await db.integration.findUnique({ where: { id: other } });
    const current = await db.integration.findUnique({ where: { id: ig } });
    const request = await integrations.beginRemoval(`channel:${ig}`, 'disconnect', [current!]);
    const removed = await db.integration.findUnique({ where: { id: ig } });
    expect(removed).toMatchObject({ token: '', refreshToken: null, disabled: true, internalId: `deleted_${ig}` });
    expect(removed!.deletedAt).toBeInstanceOf(Date);
    expect(request.status).toBe('pending');
    expect(JSON.stringify(request.targets)).not.toContain('qa-not-a-real-token');
    expect(await db.integration.findUnique({ where: { id: other } })).toEqual(protectedBefore);
  });

  test('late refresh is rejected and cannot recreate old channel', async () => {
    const before = (await db.integration.findUnique({ where: { id: ig } }))!;
    await integrations.beginRemoval(`channel:${ig}`, 'disconnect', [before]);
    expect((await integrations.updateRefreshedCredentials(before, 'late-token', 'late-refresh', 3600)).count).toBe(0);
    expect(await db.integration.count()).toBe(2);
    expect((await db.integration.findUnique({ where: { id: ig } }))!.token).toBe('');
  });

  test('fresh OAuth identity survives cleanup of the old channel', async () => {
    await integrations.beginRemoval(`channel:${ig}`, 'disconnect', [(await db.integration.findUnique({ where: { id: ig } }))!]);
    await db.integration.create({ data: newChannel('removal_qa_fresh_oauth', orgA) });
    await integrations.eraseChannelRecords(orgA, ig);
    expect((await db.integration.findUnique({ where: { id: 'removal_qa_fresh_oauth' } }))!.token).toBe('qa-not-a-real-token');
    expect((await db.integration.findUnique({ where: { id: ig } }))!.rootInternalId).toBe(createHash('md5').update(platformId).digest('hex'));
  });

  test('actual post contents and platform URLs are cleared; shared group is not a deletion boundary', async () => {
    const protectedBefore = await db.post.findUnique({ where: { id: 'removal_qa_post_b' } });
    await integrations.beginRemoval(`channel:${ig}`, 'disconnect', [(await db.integration.findUnique({ where: { id: ig } }))!]);
    await integrations.eraseChannelRecords(orgA, ig);
    expect(await db.post.findUnique({ where: { id: 'removal_qa_post_a' } })).toMatchObject({
      content: '', image: null, settings: null, releaseURL: null, releaseId: null, error: null, state: 'DRAFT',
    });
    expect(await db.post.findUnique({ where: { id: 'removal_qa_post_b' } })).toEqual(protectedBefore);
  });

  test('late publish and error cannot refill cleared rows', async () => {
    await integrations.beginRemoval(`channel:${ig}`, 'disconnect', [(await db.integration.findUnique({ where: { id: ig } }))!]);
    await integrations.eraseChannelRecords(orgA, ig);
    expect((await posts.updatePost('removal_qa_post_a', 'late-id', 'https://example.invalid/late')).count).toBe(0);
    expect(await posts.changeState('removal_qa_post_a', 'ERROR', 'late-error', 'late-body')).toBeNull();
    expect(await db.errors.count()).toBe(0);
    expect((await db.post.findUnique({ where: { id: 'removal_qa_post_a' } }))!.releaseURL).toBeNull();
  });

  test('post insertion after removal is blocked inside its transaction', async () => {
    await integrations.beginRemoval(`channel:${ig}`, 'disconnect', [(await db.integration.findUnique({ where: { id: ig } }))!]);
    await integrations.eraseChannelRecords(orgA, ig);
    await expect(posts.createOrUpdatePost('draft', orgA, new Date().toISOString(), {
      integration: { id: ig }, value: [{ content: 'late', image: [] }], settings: {},
    } as any, [], CreationMethod.WEB)).rejects.toThrow('Channel is disconnected');
    expect(await db.post.count()).toBe(2);
  });

  test('callback matching includes all copies and tombstones, never VK', async () => {
    await db.integration.create({ data: newChannel('removal_qa_ig_copy', orgB) });
    await integrations.beginRemoval(`channel:${ig}`, 'disconnect', [(await db.integration.findUnique({ where: { id: ig } }))!]);
    const ids = (await integrations.findInstagramRemovalTargets(platformId)).map(i => i.id).sort();
    expect(ids).toEqual([ig, 'removal_qa_ig_copy'].sort());
  });

  test('receipt retry never expands its fixed targets', async () => {
    const current = (await db.integration.findUnique({ where: { id: ig } }))!;
    const first = await integrations.beginRemoval(`channel:${ig}`, 'disconnect', [current]);
    const second = await integrations.beginRemoval(`channel:${ig}`, 'disconnect', [current, (await db.integration.findUnique({ where: { id: other } }))!]);
    expect(second.id).toBe(first.id);
    expect(second.targets).toEqual(first.targets);
  });

  test('media thumbnail references protect shared imported files', async () => {
    const picture = 'https://example.invalid/uploads/2026/09/14/qa.png';
    await db.media.create({ data: { id: 'removal_qa_media', organizationId: orgB, name: 'Protected', path: 'https://example.invalid/other.png', thumbnail: picture } });
    expect(await integrations.pictureIsShared(picture, ig)).toBe(true);
  });

  test('stale callback target cannot erase a newer OAuth grant on the same row', async () => {
    const old = (await db.integration.findUnique({ where: { id: ig } }))!;
    await db.integration.update({ where: { id: ig }, data: { authorizedAt: new Date(Date.now() + 2000), token: 'qa-new-grant' } });
    const receipt = await integrations.beginRemoval('meta:old-event', 'deauthorize', [old]);
    expect(receipt.targets).toEqual([]);
    expect((await db.integration.findUnique({ where: { id: ig } }))!.token).toBe('qa-new-grant');
  });

  test('account barrier prevents any new OAuth and snapshots the current channels', async () => {
    const receipt = await integrations.beginRemoval(`account:${orgA}`, 'data-deletion', [], orgA);
    expect((receipt.targets as any[]).map(i => i.id)).toEqual([ig]);
    await expect(integrations.createOrUpdateIntegration(undefined, false, orgA, 'QA new', undefined,
      'social', '990000000000099', 'instagram-standalone', 'qa-new-grant')).rejects.toThrow('Account deletion is in progress');
    expect(await db.integration.count({ where: { organizationId: orgA, token: { not: '' } } })).toBe(0);
  });

  test('local disconnect racing OAuth returns a conflict without a false-success receipt', async () => {
    const old = (await db.integration.findUnique({ where: { id: ig } }))!;
    await db.integration.update({ where: { id: ig }, data: { authorizedAt: new Date(Date.now() + 2000), token: 'qa-new-grant' } });
    await expect(integrations.beginRemoval(`channel:${ig}`, 'disconnect', [old])).rejects.toThrow('Channel reconnected');
    expect(await integrations.getRemoval(`channel:${ig}`)).toBeNull();
    const current = (await db.integration.findUnique({ where: { id: ig } }))!;
    await integrations.beginRemoval(`channel:${ig}`, 'disconnect', [current]);
    expect((await db.integration.findUnique({ where: { id: ig } }))!.token).toBe('');
  });

  test('real OAuth reconnect creates a fresh identity, old cleanup cannot wipe it', async () => {
    await integrations.beginRemoval(`channel:${ig}`, 'disconnect', [(await db.integration.findUnique({ where: { id: ig } }))!]);
    const fresh = await integrations.createOrUpdateIntegration(undefined, false, orgA, 'QA new', undefined,
      'social', platformId, 'instagram-standalone', 'qa-new-grant');
    await integrations.eraseChannelRecords(orgA, ig);
    expect(fresh.id).not.toBe(ig);
    expect((await db.integration.findUnique({ where: { id: fresh.id } }))!.token).toBe('qa-new-grant');
  });

  test('attempt claim is atomic and cannot exceed three, terminal state cannot be overwritten', async () => {
    const receipt = await integrations.beginRemoval(`channel:${ig}`, 'disconnect', [(await db.integration.findUnique({ where: { id: ig } }))!]);
    const results = await Promise.all(Array.from({ length: 8 }, () => integrations.claimRemovalAttempt(receipt.id)));
    expect(results.reduce((sum, r) => sum + r.count, 0)).toBe(3);
    await integrations.updateRemoval(receipt.id, { status: 'disconnected' });
    expect((await integrations.updateRemoval(receipt.id, { lastError: 'late worker' })).count).toBe(0);
  });

  test('late page selection cannot refill or revive a removed channel', async () => {
    const expected = await db.integration.update({ where: { id: ig }, data: { inBetweenSteps: true } });
    await integrations.beginRemoval(`channel:${ig}`, 'disconnect', [expected]);
    await integrations.eraseChannelRecords(orgA, ig);
    await expect(integrations.updateIntegration(ig, { organizationId: orgA, internalId: 'qa-selected-page', token: 'qa-late-page-token' }, expected))
      .rejects.toThrow('Channel was removed or reconnected');
    expect(await db.integration.findUnique({ where: { id: ig } })).toMatchObject({ token: '', internalId: `deleted_${ig}`, disabled: true });
  });

  test('normal page selection remains functional without resurrecting a deleted id', async () => {
    const expected = await db.integration.update({ where: { id: ig }, data: { inBetweenSteps: true } });
    const result = await integrations.updateIntegration(ig, { organizationId: orgA, internalId: 'qa-selected-page', token: 'qa-page-token', inBetweenSteps: false }, expected);
    expect(result).toMatchObject({ id: ig, token: 'qa-page-token', internalId: 'qa-selected-page', deletedAt: null });
  });

  test('late provider migration cannot rename a removed identity for a subsequent upsert', async () => {
    await integrations.beginRemoval(`channel:${ig}`, 'disconnect', [(await db.integration.findUnique({ where: { id: ig } }))!]);
    await expect(integrations.migrateIntegration(orgA, ig, 'qa-new-scoped-id', 'instagram', 'qa-root')).rejects.toThrow();
    expect(await db.integration.findUnique({ where: { id: ig } })).toMatchObject({ token: '', internalId: `deleted_${ig}`, disabled: true });
  });
});
