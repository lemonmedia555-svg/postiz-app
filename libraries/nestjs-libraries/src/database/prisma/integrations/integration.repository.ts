import { PrismaRepository, PrismaTransaction } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import dayjs from 'dayjs';
import { Integration, Prisma } from '@prisma/client';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { IntegrationTimeDto } from '@gitroom/nestjs-libraries/dtos/integrations/integration.time.dto';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { PlugDto } from '@gitroom/nestjs-libraries/dtos/plugs/plug.dto';

export class ChannelAuthorizationChanged extends Error {}
export class GrantClosedDuringConnection extends ChannelAuthorizationChanged {}

@Injectable()
export class IntegrationRepository {
  private storage = UploadFactory.createStorage();
  constructor(
    private _integration: PrismaRepository<'integration'>,
    private _posts: PrismaRepository<'post'>,
    private _plugs: PrismaRepository<'plugs'>,
    private _exisingPlugData: PrismaRepository<'exisingPlugData'>,
    private _customers: PrismaRepository<'customer'>,
    private _mentions: PrismaRepository<'mentions'>,
    private _transaction: PrismaTransaction,
    private _removal: PrismaRepository<'integrationRemoval' | 'media'>
  ) {}

  private grantPrefix(provider: string, root: string) {
    return 'grant:' + createHash('sha256').update(`${provider}:${root}`).digest('hex') + ':';
  }

  private async lockGrant(tx: Prisma.TransactionClient, provider: string, root: string) {
    const hash = createHash('sha256').update(`${provider}:${root}`).digest('hex');
    const key = BigInt.asIntN(64, BigInt(`0x${hash.slice(0, 16)}`));
    await tx.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(${key})`;
  }

  private async assertGrantOpen(tx: Prisma.TransactionClient, provider: string, root: string,
    oauthCallbackStartedAt?: Date) {
    await this.lockGrant(tx, provider, root);
    const staleGrant = await tx.integrationRemoval.findFirst({ where: {
      scope: { startsWith: this.grantPrefix(provider, root) },
      OR: [{ status: 'pending' }, ...(oauthCallbackStartedAt
        ? [{ createdAt: { gte: oauthCallbackStartedAt } }] : [])],
    } });
    if (staleGrant) throw new GrantClosedDuringConnection('Authorization was revoked during connection; reconnect');
  }

  private async accountDeletionStarted(tx: Prisma.TransactionClient, org: string) {
    return !!(await tx.integrationRemoval.findFirst({ where: { OR: [
      { scope: `account:${org}` },
      { scope: `account-fence:${org}`, status: 'pending' },
    ] } }));
  }

  getMentions(platform: string, q: string) {
    return this._mentions.model.mentions.findMany({
      where: {
        platform,
        OR: [
          {
            name: {
              contains: q,
              mode: 'insensitive',
            },
          },
          {
            username: {
              contains: q,
              mode: 'insensitive',
            },
          },
        ],
      },
      orderBy: {
        name: 'asc',
      },
      take: 100,
      select: {
        name: true,
        username: true,
        image: true,
      },
    });
  }

  insertMentions(
    platform: string,
    mentions: { name: string; username: string; image: string }[]
  ) {
    if (mentions.length === 0) {
      return [] as any[];
    }
    return this._mentions.model.mentions.createMany({
      data: mentions.map((mention) => ({
        platform,
        name: mention.name,
        username: mention.username,
        image: mention.image,
      })),
      skipDuplicates: true,
    });
  }

  async checkPreviousConnections(org: string, id: string) {
    // Deleted accounts keep their integrations with an md5 hashed
    // rootInternalId, so match both the raw id and its hash to still catch
    // channels that were connected by a deleted account.
    const findIt = await this._integration.model.integration.findMany({
      where: {
        rootInternalId: {
          in: [id, createHash('md5').update(id).digest('hex')],
        },
      },
      select: {
        organizationId: true,
        id: true,
      },
    });

    if (findIt.some((f) => f.organizationId === org)) {
      return false;
    }

    return findIt.length > 0;
  }

  updateProviderSettings(org: string, id: string, settings: string) {
    return this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
        deletedAt: null,
      },
      data: {
        additionalSettings: settings,
      },
    });
  }

  async setTimes(org: string, id: string, times: IntegrationTimeDto) {
    return this._integration.model.integration.update({
      select: {
        id: true,
      },
      where: {
        id,
        organizationId: org,
        deletedAt: null,
      },
      data: {
        postingTimes: JSON.stringify(times.time),
      },
    });
  }

  getPlug(plugId: string) {
    return this._plugs.model.plugs.findFirst({
      where: {
        id: plugId,
      },
      include: {
        integration: true,
      },
    });
  }

  async getPlugs(orgId: string, integrationId: string) {
    return this._plugs.model.plugs.findMany({
      where: {
        integrationId,
        organizationId: orgId,
        activated: true,
      },
      include: {
        integration: {
          select: {
            id: true,
            providerIdentifier: true,
          },
        },
      },
    });
  }

  async updateIntegration(id: string, params: Partial<Integration>, expected: Integration) {
    if (
      params.picture &&
      (params.picture.indexOf(process.env.CLOUDFLARE_BUCKET_URL!) === -1 ||
        params.picture.indexOf(process.env.FRONTEND_URL!) === -1)
    ) {
      params.picture = await this.storage.uploadSimple(params.picture);
    }

    return this._transaction.model.$transaction(async tx => {
      const org = expected.organizationId;
      await this.assertGrantOpen(tx, expected.providerIdentifier, expected.rootInternalId || expected.internalId);
      if (org !== params.organizationId || expected.id !== id) throw new ChannelAuthorizationChanged();
      const account = await tx.organization.updateMany({ where: { id: org, deletedAt: null }, data: { updatedAt: new Date() } });
      if (!account.count || await this.accountDeletionStarted(tx, org)) {
        throw new ChannelAuthorizationChanged('Account deletion is in progress');
      }
      const current = await tx.integration.updateMany({ where: {
        id, organizationId: org, deletedAt: null, disabled: false,
        token: expected.token, authorizedAt: expected.authorizedAt, inBetweenSteps: true,
      }, data: { updatedAt: new Date() } });
      if (!current.count) throw new ChannelAuthorizationChanged('Channel was removed or reconnected');
      const existing = await tx.integration.findUnique({ where: {
        organizationId_internalId: { organizationId: org, internalId: params.internalId! },
      } });
      // Never revive a deleted target with an old terminal removal receipt.
      if (existing && existing.id !== id && (existing.deletedAt || existing.disabled || !existing.token)) {
        throw new ChannelAuthorizationChanged('Selected channel is disconnected; reconnect it explicitly');
      }
      if (existing && existing.id !== id) {
        await tx.post.updateMany({ where: { integrationId: id, organizationId: org }, data: { deletedAt: new Date() } });
        await tx.integration.update({ where: { id }, data: {
          internalId: `deleted_${id}`, deletedAt: new Date(), disabled: true, token: '', refreshToken: null, tokenExpiration: null,
        } });
      }
      return tx.integration.update({ where: {
        id: existing?.id || id, organizationId: org, deletedAt: null, disabled: false,
      }, data: { ...params, authorizedAt: new Date(), disabled: false } });
    });
  }

  disconnectChannel(org: string, id: string) {
    return this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: {
        refreshNeeded: true,
      },
    });
  }

  async findInstagramRemovalTargets(internalId: string) {
    const hashedInternalId = createHash('md5').update(internalId).digest('hex');
    return this._integration.model.integration.findMany({
      where: {
        providerIdentifier: 'instagram-standalone',
        OR: [
          {
            internalId: {
              in: [internalId, `deauthorized_${hashedInternalId}`],
            },
          },
          { rootInternalId: { in: [internalId, hashedInternalId] } },
        ],
      },
    });
  }

  getRemoval(scope: string) {
    return this._removal.model.integrationRemoval.findUnique({ where: { scope } });
  }

  getRemovalById(id: string) {
    return this._removal.model.integrationRemoval.findUnique({ where: { id } });
  }

  async pendingRemovals() {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const [ordinary, grants] = await Promise.all([
      this._removal.model.integrationRemoval.findMany({
        where: { status: 'pending', attempts: { lt: 3 },
          NOT: { scope: { startsWith: 'grant:' } }, mode: { not: 'account-fence' } },
        take: 10, orderBy: { createdAt: 'asc' },
      }),
      this._removal.model.integrationRemoval.findMany({
        where: { status: 'pending', scope: { startsWith: 'grant:' },
          OR: [{ attempts: { lt: 3 } }, { updatedAt: { lte: oneHourAgo } }] },
        take: 10, orderBy: { createdAt: 'asc' },
      }),
    ]);
    return [...ordinary, ...grants]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, 10);
  }

  updateRemoval(id: string, data: Prisma.IntegrationRemovalUpdateInput) {
    return this._removal.model.integrationRemoval.updateMany({ where: { id, status: 'pending' }, data });
  }

  claimRemovalAttempt(id: string, grant = false) {
    return this._removal.model.integrationRemoval.updateMany({
      where: { id, status: 'pending', ...(grant ? {} : { attempts: { lt: 3 } }) },
      data: { attempts: { increment: 1 } },
    });
  }

  async beginAccountDeletionFence(org: string) {
    return this._transaction.model.$transaction(async tx => {
      await tx.organization.update({ where: { id: org }, data: { updatedAt: new Date() } });
      const scope = `account-fence:${org}`;
      return await tx.integrationRemoval.findUnique({ where: { scope } }) ||
        tx.integrationRemoval.create({ data: {
          id: makeId(32), scope, mode: 'account-fence', targets: [],
        } });
    });
  }

  finishAccountDeletionFence(org: string) {
    return this._removal.model.integrationRemoval.updateMany({
      where: { scope: `account-fence:${org}`, status: 'pending' },
      data: { status: 'active_data_deleted_pending_review' },
    });
  }

  async beginRemoval(scope: string, mode: string, integrations: Integration[], closeOrganization?: string,
    authorizationGroup?: { providerIdentifier: string; rootInternalId: string; revokeAuthorization: boolean }) {
    return this._transaction.model.$transaction(async (tx) => {
      if (authorizationGroup) {
        await this.lockGrant(tx, authorizationGroup.providerIdentifier, authorizationGroup.rootInternalId);
      }
      if (closeOrganization) {
        await tx.organization.update({ where: { id: closeOrganization }, data: { updatedAt: new Date() } });
        integrations = await tx.integration.findMany({ where: { organizationId: closeOrganization } });
      }
      const existing = await tx.integrationRemoval.findUnique({ where: { scope } });
      if (existing) return existing;
      if (authorizationGroup) {
        const requested = await tx.integration.findFirst({ where: {
          id: integrations[0]?.id, organizationId: integrations[0]?.organizationId,
          providerIdentifier: authorizationGroup.providerIdentifier,
          rootInternalId: authorizationGroup.rootInternalId,
          deletedAt: null,
        } });
        if (!requested || (requested.authorizedAt || requested.createdAt).getTime() !==
            (integrations[0].authorizedAt || integrations[0].createdAt).getTime()) {
          throw new ChannelAuthorizationChanged('Channel reconnected; retry removal');
        }
        integrations = await tx.integration.findMany({ where: {
          providerIdentifier: authorizationGroup.providerIdentifier,
          rootInternalId: authorizationGroup.rootInternalId,
          deletedAt: null,
        } });
      }
      const targets = [];
      for (const integration of integrations) {
        const current = await tx.integration.findFirst({
          where: { id: integration.id, organizationId: integration.organizationId },
        });
        if (!current) continue;
        // An OAuth completed since target selection: this is a new grant.
        if ((current.authorizedAt || current.createdAt).getTime() !==
            (integration.authorizedAt || integration.createdAt).getTime()) {
          if (mode === 'disconnect') throw new ChannelAuthorizationChanged('Channel reconnected; retry removal');
          continue;
        }
        const posts = await tx.post.findMany({
          where: { integrationId: current.id, organizationId: current.organizationId },
          select: { id: true },
        });
        const revokeAuthorization = !!authorizationGroup?.revokeAuthorization &&
          current.providerIdentifier === authorizationGroup.providerIdentifier &&
          !!(current.refreshToken || current.token);
        targets.push({ id: current.id, org: current.organizationId,
          picture: current.picture, posts: posts.map(p => p.id),
          providerIdentifier: current.providerIdentifier, revokeAuthorization });
        const root = current.rootInternalId || current.internalId;
        const tombstone = /^[a-f0-9]{32}$/.test(root) ? root : createHash('md5').update(root).digest('hex');
        // Commit the barrier with the durable receipt. A provider that requires
        // remote revocation keeps credentials only while disabled so a failed
        // Google request can be retried; all other credentials are cleared now.
        await tx.integration.update({ where: { id: current.id }, data: {
          disabled: true, deletedAt: new Date(),
          token: revokeAuthorization ? current.token : '',
          refreshToken: revokeAuthorization ? current.refreshToken : null,
          tokenExpiration: null, refreshNeeded: false,
          internalId: `deleted_${current.id}`, rootInternalId: tombstone,
        } });
        await tx.post.updateMany({
          where: { integrationId: current.id, organizationId: current.organizationId },
          data: { deletedAt: new Date(), state: 'DRAFT', intervalInDays: null },
        });
      }
      return tx.integrationRemoval.create({ data: {
        id: makeId(32), scope, mode, targets,
      } });
    }, { isolationLevel: authorizationGroup
      ? Prisma.TransactionIsolationLevel.ReadCommitted
      : Prisma.TransactionIsolationLevel.Serializable });
  }

  async eraseChannelRecords(org: string, id: string) {
    return this._transaction.model.$transaction(async (tx) => {
      const current = await tx.integration.findFirst({ where: { id, organizationId: org } });
      if (!current) return [];
      const originalId = current.rootInternalId || current.internalId;
      const rootHash = /^[a-f0-9]{32}$/.test(originalId) ? originalId
        : createHash('md5').update(originalId).digest('hex');
      const postWhere = { organizationId: org, integrationId: id };
      const posts = await tx.post.findMany({ where: postWhere, select: { id: true } });
      const ids = posts.map(p => p.id);
      await tx.comments.deleteMany({ where: { postId: { in: ids } } });
      await tx.errors.deleteMany({ where: { postId: { in: ids } } });
      await tx.tagsPosts.deleteMany({ where: { postId: { in: ids } } });
      await tx.plugs.deleteMany({ where: { integrationId: id, organizationId: org } });
      await tx.exisingPlugData.deleteMany({ where: { integrationId: id } });
      await tx.integrationsWebhooks.deleteMany({ where: { integrationId: id } });
      const autoposts = await tx.autoPost.findMany({ where: { organizationId: org, deletedAt: null } });
      for (const autopost of autoposts) {
        let selected: Array<{ id: string }>;
        try { selected = JSON.parse(autopost.integrations); } catch { continue; }
        if (!Array.isArray(selected) || !selected.some(item => item.id === id)) continue;
        const remaining = selected.filter(item => item.id !== id);
        // An empty list means ALL channels in this feature: disable instead.
        await tx.autoPost.update({ where: { id: autopost.id }, data: {
          integrations: JSON.stringify(remaining), ...(remaining.length ? {} : { active: false }),
        } });
      }
      // Keep only technical rows required by financial/parent foreign keys.
      // The actual stored content and platform identifiers are overwritten.
      await tx.post.updateMany({ where: postWhere, data: {
        deletedAt: new Date(), state: 'DRAFT', content: '', title: null,
        description: null, releaseId: null, releaseURL: null, settings: null,
        image: null, error: null, intervalInDays: null, lastMessageId: null,
      } });
      await tx.integration.updateMany({ where: { id, organizationId: org }, data: {
        name: 'Deleted channel', picture: null, profile: null, token: '',
        refreshToken: null, tokenExpiration: null, customInstanceDetails: null,
        additionalSettings: '[]', customerId: null, disabled: true,
        inBetweenSteps: false, refreshNeeded: false, deletedAt: new Date(),
        internalId: `deleted_${id}`, rootInternalId: rootHash,
        // Keep a non-public matching tombstone for a later signed Meta request.
        // Historic backups and tombstones require the separate review stage.
      } });
      return ids;
    });
  }

  async pictureIsShared(picture: string, excludingId: string) {
    return !!(await this._integration.model.integration.findFirst({
      where: { picture, id: { not: excludingId } }, select: { id: true },
    })) || !!(await this._removal.model.media.findFirst({
      where: { OR: [{ path: picture }, { thumbnail: picture }] }, select: { id: true },
    })) || !!(await this._posts.model.post.findFirst({
      where: { integrationId: { not: excludingId }, image: { contains: picture } },
      select: { id: true },
    }));
  }

  async updateRefreshedCredentials(integration: Integration, accessToken: string,
    refreshToken?: string, expiresIn?: number, oneTimeToken = false) {
    return this._transaction.model.$transaction(async tx => {
      await this.assertGrantOpen(tx, integration.providerIdentifier,
        integration.rootInternalId || integration.internalId);
      const data = { token: accessToken, refreshToken: refreshToken || null,
        ...(expiresIn ? { tokenExpiration: new Date(Date.now() + expiresIn * 1000) } : {}),
        refreshNeeded: false };
      const saved = await tx.integration.updateMany({
      where: { id: integration.id, organizationId: integration.organizationId,
        deletedAt: null, disabled: false, token: integration.token },
      data,
      });
      if (saved.count && oneTimeToken) await tx.integration.updateMany({
        where: { id: { not: integration.id }, organizationId: integration.organizationId,
          providerIdentifier: integration.providerIdentifier, rootInternalId: integration.rootInternalId || integration.internalId,
          deletedAt: null, disabled: false, token: integration.token }, data,
      });
      return saved;
    });
  }

  getIntegrationByInternalId(org: string, internalId: string) {
    return this._integration.model.integration.findFirst({
      where: {
        organizationId: org,
        internalId,
        deletedAt: null,
      },
    });
  }

  // Moves a channel to another provider in place (MIGRATE_PROVIDERS): only the
  // provider and the app-scoped ids change, so the integration id - and with it
  // scheduled posts, settings and customers - survives the migration. The
  // follow-up createOrUpdateIntegration upsert matches the new internalId and
  // stores the fresh tokens.
  async migrateIntegration(
    org: string,
    id: string,
    internalId: string,
    providerIdentifier: string,
    rootInternalId: string,
    oauthCallbackStartedAt?: Date
  ) {
    return this._transaction.model.$transaction(async tx => {
    await this.assertGrantOpen(tx, providerIdentifier, rootInternalId, oauthCallbackStartedAt);
    const account = await tx.organization.updateMany({ where: { id: org, deletedAt: null }, data: { updatedAt: new Date() } });
    if (!account.count || await this.accountDeletionStarted(tx, org)) {
      throw new ChannelAuthorizationChanged('Account deletion is in progress');
    }
    const current = await tx.integration.updateMany({ where: { id, organizationId: org, deletedAt: null }, data: { updatedAt: new Date() } });
    if (!current.count) throw new ChannelAuthorizationChanged('Channel was removed');
    // A soft-deleted channel can still hold the target internalId
    // (deleteChannel keeps it): rename it out of the way like updateIntegration
    // does, otherwise the organizationId_internalId unique constraint rejects
    // the migration. Live channels are rejected by the service before this.
    const existing = await tx.integration.findUnique({
      where: {
        organizationId_internalId: {
          organizationId: org,
          internalId,
        },
      },
    });

    if (existing && existing.deletedAt) {
      await tx.integration.update({
        where: {
          id: existing.id,
        },
        data: {
          internalId: `deleted_${internalId}_${makeId(10)}`,
        },
      });
    }

    return tx.integration.update({
      where: {
        id,
        organizationId: org,
        deletedAt: null,
        organization: { deletedAt: null },
      },
      data: {
        internalId,
        providerIdentifier,
        rootInternalId,
      },
    });
    });
  }

  async createOrUpdateIntegration(...args: Parameters<IntegrationRepository['writeIntegration']>) {
    return this._transaction.model.$transaction(async tx => {
      await this.assertGrantOpen(tx, args[7], args[18] || args[6], args[16]);
      const org = args[2];
      const active = await tx.organization.updateMany({ where: { id: org, deletedAt: null }, data: { updatedAt: new Date() } });
      if (!active.count || await this.accountDeletionStarted(tx, org)) {
        throw new Error('Account deletion is in progress');
      }
      if (args[17]) await args[17]();
      const model = { model: tx } as any;
      return new IntegrationRepository(model, model, model, model, model, model, this._transaction, model).writeIntegration(...args);
    }, { timeout: 15000 });
  }

  private async writeIntegration(
    additionalSettings:
      | {
          title: string;
          description: string;
          type: 'checkbox' | 'text' | 'textarea';
          value: any;
          regex?: string;
        }[]
      | undefined,
    oneTimeToken: boolean,
    org: string,
    name: string,
    picture: string | undefined,
    type: 'article' | 'social',
    internalId: string,
    provider: string,
    token: string,
    refreshToken = '',
    expiresIn = 999999999,
    username?: string,
    isBetweenSteps = false,
    refresh?: string,
    timezone?: number,
    customInstanceDetails?: string,
    oauthCallbackStartedAt?: Date,
    verifyAuthorization?: () => Promise<void>,
    oauthRootId?: string
  ) {
    const postTimes = timezone
      ? {
          postingTimes: JSON.stringify([
            { time: 560 - timezone },
            { time: 850 - timezone },
            { time: 1140 - timezone },
          ]),
        }
      : {};
    const upsert = await this._integration.model.integration.upsert({
      where: {
        organizationId_internalId: {
          internalId,
          organizationId: org,
        },
      },
      create: {
        type: type as any,
        authorizedAt: new Date(),
        name,
        providerIdentifier: provider,
        token,
        profile: username,
        ...(picture ? { picture } : {}),
        inBetweenSteps: isBetweenSteps,
        refreshToken,
        ...(expiresIn
          ? { tokenExpiration: new Date(Date.now() + expiresIn * 1000) }
          : {}),
        internalId,
        ...postTimes,
        organizationId: org,
        refreshNeeded: false,
        rootInternalId: oauthRootId || internalId,
        ...(customInstanceDetails ? { customInstanceDetails } : {}),
        additionalSettings: additionalSettings
          ? JSON.stringify(additionalSettings)
          : '[]',
      },
      update: {
        authorizedAt: new Date(),
        ...(additionalSettings
          ? { additionalSettings: JSON.stringify(additionalSettings) }
          : {}),
        ...(customInstanceDetails ? { customInstanceDetails } : {}),
        type: type as any,
        ...(!refresh
          ? {
              inBetweenSteps: isBetweenSteps,
            }
          : {}),
        ...(picture ? { picture } : {}),
        profile: username,
        providerIdentifier: provider,
        ...(oauthRootId ? { rootInternalId: oauthRootId } : {}),
        token,
        refreshToken,
        ...(expiresIn
          ? { tokenExpiration: new Date(Date.now() + expiresIn * 1000) }
          : {}),
        internalId,
        organizationId: org,
        deletedAt: null,
        refreshNeeded: false,
      },
    });

    if (oneTimeToken) {
      const rootId =
        (
          await this._integration.model.integration.findFirst({
            where: {
              organizationId: org,
              internalId: internalId,
            },
          })
        )?.rootInternalId || internalId;

      await this._integration.model.integration.updateMany({
        where: {
          id: {
            not: upsert.id,
          },
          rootInternalId: rootId,
          organizationId: org,
          deletedAt: null,
          disabled: false,
          providerIdentifier: provider,
        },
        data: {
          token,
          refreshToken,
          refreshNeeded: false,
          ...(expiresIn
            ? { tokenExpiration: new Date(Date.now() + expiresIn * 1000) }
            : {}),
        },
      });
    }

    return upsert;
  }

  needsToBeRefreshed() {
    return this._integration.model.integration.findMany({
      where: {
        tokenExpiration: {
          lte: dayjs().add(1, 'day').toDate(),
        },
        inBetweenSteps: false,
        deletedAt: null,
        refreshNeeded: false,
      },
    });
  }

  activeYoutubeChannels() {
    return this._integration.model.integration.findMany({
      where: { providerIdentifier: 'youtube', deletedAt: null, disabled: false, inBetweenSteps: false },
    });
  }

  updateYoutubeChannelMetadata(integration: Integration, data: { name: string; picture: string; username: string }) {
    return this._integration.model.integration.updateMany({
      where: { id: integration.id, organizationId: integration.organizationId,
        providerIdentifier: 'youtube', deletedAt: null, disabled: false, token: integration.token },
      data: { name: data.name, picture: data.picture || null, profile: data.username || null,
        customInstanceDetails: JSON.stringify({ youtubeDataRefreshedAt: new Date().toISOString() }) },
    });
  }

  async setBetweenRefreshSteps(id: string) {
    return this._integration.model.integration.updateMany({
      where: {
        id,
        deletedAt: null,
      },
      data: {
        inBetweenSteps: true,
      },
    });
  }
  refreshNeeded(org: string, id: string) {
    return this._integration.model.integration.updateMany({
      where: {
        id,
        organizationId: org,
        deletedAt: null,
      },
      data: {
        refreshNeeded: true,
      },
    });
  }

  updateNameAndUrl(id: string, name: string, url: string) {
    return this._integration.model.integration.updateMany({
      where: {
        id,
        deletedAt: null,
      },
      data: {
        ...(name ? { name } : {}),
        ...(url ? { picture: url } : {}),
      },
    });
  }

  getIntegrationById(org: string, id: string) {
    return this._integration.model.integration.findFirst({
      where: {
        organizationId: org,
        organization: { deletedAt: null },
        id,
      },
    });
  }

  async getIntegrationForOrder(
    id: string,
    order: string,
    user: string,
    org: string
  ) {
    const integration = await this._posts.model.post.findFirst({
      where: {
        integrationId: id,
        submittedForOrder: {
          id: order,
          messageGroup: {
            OR: [
              { sellerId: user },
              { buyerId: user },
              { buyerOrganizationId: org },
            ],
          },
        },
      },
      select: {
        integration: {
          select: {
            id: true,
            name: true,
            picture: true,
            inBetweenSteps: true,
            providerIdentifier: true,
          },
        },
      },
    });

    return integration?.integration;
  }

  async updateOnCustomerName(org: string, id: string, name: string) {
    const customer = !name
      ? undefined
      : (await this._customers.model.customer.findFirst({
          where: {
            orgId: org,
            name,
          },
        })) ||
        (await this._customers.model.customer.create({
          data: {
            name,
            orgId: org,
          },
        }));

    return this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: {
        customer: !customer
          ? { disconnect: true }
          : {
              connect: {
                id: customer.id,
              },
            },
      },
    });
  }

  updateIntegrationGroup(org: string, id: string, group: string) {
    return this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
        deletedAt: null,
      },
      data: !group
        ? {
            customer: {
              disconnect: true,
            },
          }
        : {
            customer: {
              connect: {
                id: group,
              },
            },
          },
    });
  }

  customers(orgId: string) {
    return this._customers.model.customer.findMany({
      where: {
        orgId,
        deletedAt: null,
      },
    });
  }

  getIntegrationsList(org: string) {
    return this._integration.model.integration.findMany({
      where: {
        organizationId: org,
        deletedAt: null,
      },
      include: {
        customer: true,
      },
    });
  }

  getAllChannelsForRemoval(org: string) {
    return this._integration.model.integration.findMany({ where: { organizationId: org } });
  }

  getPendingAuthorizationRemovals() {
    return this._removal.model.integrationRemoval.findMany({
      where: { status: 'pending', scope: { startsWith: 'grant:' } },
    });
  }

  async disableChannel(org: string, id: string) {
    await this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: {
        disabled: true,
      },
    });
  }

  async enableChannel(org: string, id: string) {
    await this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
        deletedAt: null,
        token: { not: '' },
      },
      data: {
        disabled: false,
      },
    });
  }

  getPostsForChannel(org: string, id: string) {
    return this._posts.model.post.groupBy({
      by: ['group'],
      where: {
        organizationId: org,
        integrationId: id,
        deletedAt: null,
      },
    });
  }

  deleteChannel(org: string, id: string) {
    return this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: {
        deletedAt: new Date(),
      },
    });
  }

  async deleteIntegrationsForAccount(org: string) {
    const hash = (value: string) =>
      createHash('md5').update(value).digest('hex');

    await this._posts.model.post.updateMany({
      where: {
        organizationId: org,
        deletedAt: null,
      },
      data: {
        deletedAt: new Date(),
      },
    });

    const integrations = await this._integration.model.integration.findMany({
      where: {
        organizationId: org,
      },
    });

    // md5 is deterministic, so a hashed rootInternalId can still be matched
    // by checkPreviousConnections when the same channel is connected again
    // from a new account.
    for (const integration of integrations) {
      await this._integration.model.integration.update({
        where: {
          id: integration.id,
        },
        data: {
          name: hash(integration.name),
          internalId: hash(integration.internalId),
          rootInternalId: integration.rootInternalId
            ? hash(integration.rootInternalId)
            : null,
          token: hash(integration.token),
          refreshToken: integration.refreshToken
            ? hash(integration.refreshToken)
            : null,
          profile: integration.profile ? hash(integration.profile) : null,
          customInstanceDetails: integration.customInstanceDetails
            ? hash(integration.customInstanceDetails)
            : null,
          picture: null,
          deletedAt: integration.deletedAt || new Date(),
        },
      });
    }
  }

  async checkForDeletedOnceAndUpdate(org: string, page: string) {
    return this._integration.model.integration.updateMany({
      where: {
        organizationId: org,
        internalId: page,
        deletedAt: {
          not: null,
        },
      },
      data: {
        internalId: makeId(10),
      },
    });
  }

  async disableIntegrations(org: string, totalChannels: number) {
    const getChannels = await this._integration.model.integration.findMany({
      where: {
        organizationId: org,
        disabled: false,
        deletedAt: null,
      },
      take: totalChannels,
      select: {
        id: true,
      },
    });

    for (const channel of getChannels) {
      await this._integration.model.integration.update({
        where: {
          id: channel.id,
        },
        data: {
          disabled: true,
        },
      });
    }
  }

  getPlugsByIntegrationId(org: string, id: string) {
    return this._plugs.model.plugs.findMany({
      where: {
        organizationId: org,
        integrationId: id,
      },
    });
  }

  createOrUpdatePlug(org: string, integrationId: string, body: PlugDto) {
    return this._plugs.model.plugs.upsert({
      where: {
        organizationId: org,
        plugFunction_integrationId: {
          integrationId,
          plugFunction: body.func,
        },
      },
      create: {
        integrationId,
        organizationId: org,
        plugFunction: body.func,
        data: JSON.stringify(body.fields),
        activated: true,
      },
      update: {
        data: JSON.stringify(body.fields),
      },
      select: {
        activated: true,
      },
    });
  }

  changePlugActivation(orgId: string, plugId: string, status: boolean) {
    return this._plugs.model.plugs.update({
      where: {
        organizationId: orgId,
        id: plugId,
      },
      data: {
        activated: !!status,
      },
    });
  }

  async loadExisingData(
    methodName: string,
    integrationId: string,
    id: string[]
  ) {
    return this._exisingPlugData.model.exisingPlugData.findMany({
      where: {
        integrationId,
        methodName,
        value: {
          in: id,
        },
      },
    });
  }

  async saveExisingData(
    methodName: string,
    integrationId: string,
    value: string[]
  ) {
    return this._exisingPlugData.model.exisingPlugData.createMany({
      data: value.map((p) => ({
        integrationId,
        methodName,
        value: p,
      })),
    });
  }

  async getPostingTimes(orgId: string, integrationsId?: string) {
    return this._integration.model.integration.findMany({
      where: {
        ...(integrationsId ? { id: integrationsId } : {}),
        organizationId: orgId,
        disabled: false,
        deletedAt: null,
      },
      select: {
        postingTimes: true,
      },
    });
  }
}
