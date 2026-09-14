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
      if (org !== params.organizationId || expected.id !== id) throw new ChannelAuthorizationChanged();
      const account = await tx.organization.updateMany({ where: { id: org, deletedAt: null }, data: { updatedAt: new Date() } });
      if (!account.count || await tx.integrationRemoval.findUnique({ where: { scope: `account:${org}` } })) {
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

  pendingRemovals() {
    return this._removal.model.integrationRemoval.findMany({
      where: { status: 'pending', attempts: { lt: 3 } }, take: 10,
      orderBy: { createdAt: 'asc' },
    });
  }

  updateRemoval(id: string, data: Prisma.IntegrationRemovalUpdateInput) {
    return this._removal.model.integrationRemoval.updateMany({ where: { id, status: 'pending' }, data });
  }

  claimRemovalAttempt(id: string) {
    return this._removal.model.integrationRemoval.updateMany({
      where: { id, status: 'pending', attempts: { lt: 3 } }, data: { attempts: { increment: 1 } },
    });
  }

  async beginRemoval(scope: string, mode: string, integrations: Integration[], closeOrganization?: string) {
    return this._transaction.model.$transaction(async (tx) => {
      if (closeOrganization) {
        await tx.organization.update({ where: { id: closeOrganization }, data: { updatedAt: new Date() } });
        integrations = await tx.integration.findMany({ where: { organizationId: closeOrganization } });
      }
      const existing = await tx.integrationRemoval.findUnique({ where: { scope } });
      if (existing) return existing;
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
        targets.push({ id: current.id, org: current.organizationId,
          picture: current.picture, posts: posts.map(p => p.id) });
        const root = current.rootInternalId || current.internalId;
        const tombstone = /^[a-f0-9]{32}$/.test(root) ? root : createHash('md5').update(root).digest('hex');
        // Commit the barrier with the durable receipt. Never retain a usable
        // credential while waiting for a cache, workflow or storage retry.
        await tx.integration.update({ where: { id: current.id }, data: {
          disabled: true, deletedAt: new Date(), token: '', refreshToken: null,
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
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
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
    rootInternalId: string
  ) {
    return this._transaction.model.$transaction(async tx => {
    const account = await tx.organization.updateMany({ where: { id: org, deletedAt: null }, data: { updatedAt: new Date() } });
    if (!account.count || await tx.integrationRemoval.findUnique({ where: { scope: `account:${org}` } })) {
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
      const org = args[2];
      const active = await tx.organization.updateMany({ where: { id: org, deletedAt: null }, data: { updatedAt: new Date() } });
      if (!active.count || await tx.integrationRemoval.findUnique({ where: { scope: `account:${org}` } })) {
        throw new Error('Account deletion is in progress');
      }
      const model = { model: tx } as any;
      return new IntegrationRepository(model, model, model, model, model, model, this._transaction, model).writeIntegration(...args);
    });
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
    customInstanceDetails?: string
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
        rootInternalId: internalId,
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
