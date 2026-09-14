import {
  forwardRef,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ChannelAuthorizationChanged, IntegrationRepository } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.repository';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import {
  AnalyticsData,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { Integration, Organization } from '@prisma/client';
import { NotificationService } from '@gitroom/nestjs-libraries/database/prisma/notifications/notification.service';
import dayjs from 'dayjs';
import { timer } from '@gitroom/helpers/utils/timer';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import {
  NotEnoughScopes,
  RefreshToken,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { IntegrationTimeDto } from '@gitroom/nestjs-libraries/dtos/integrations/integration.time.dto';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { PlugDto } from '@gitroom/nestjs-libraries/dtos/plugs/plug.dto';
import { difference, uniq } from 'lodash';
import utc from 'dayjs/plugin/utc';
import { AutopostRepository } from '@gitroom/nestjs-libraries/database/prisma/autopost/autopost.repository';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { TemporalService } from 'nestjs-temporal-core';
import { Cron } from '@nestjs/schedule';
import { createHash } from 'crypto';
import { withProviderAuthorization } from '@gitroom/nestjs-libraries/integrations/provider.authorization';

dayjs.extend(utc);

@Injectable()
export class IntegrationService {
  private storage = UploadFactory.createStorage();
  constructor(
    private _integrationRepository: IntegrationRepository,
    private _autopostsRepository: AutopostRepository,
    private _integrationManager: IntegrationManager,
    private _notificationService: NotificationService,
    @Inject(forwardRef(() => RefreshIntegrationService))
    private _refreshIntegrationService: RefreshIntegrationService,
    private _temporalService: TemporalService
  ) {}

  async changeActiveCron(orgId: string) {
    const data = await this._autopostsRepository.getAutoposts(orgId);

    for (const item of data.filter((f) => f.active)) {
      try {
        await this._temporalService.terminateWorkflow(`autopost-${item.id}`);
      } catch (err) {}
    }

    return true;
  }

  getMentions(platform: string, q: string) {
    return this._integrationRepository.getMentions(platform, q);
  }

  insertMentions(
    platform: string,
    mentions: { name: string; username: string; image: string }[]
  ) {
    return this._integrationRepository.insertMentions(platform, mentions);
  }

  async setTimes(
    orgId: string,
    integrationId: string,
    times: IntegrationTimeDto
  ) {
    return this._integrationRepository.setTimes(orgId, integrationId, times);
  }

  updateProviderSettings(org: string, id: string, additionalSettings: string) {
    return this._integrationRepository.updateProviderSettings(
      org,
      id,
      additionalSettings
    );
  }

  checkPreviousConnections(org: string, id: string) {
    return this._integrationRepository.checkPreviousConnections(org, id);
  }

  async createOrUpdateIntegration(
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
    expiresIn?: number,
    username?: string,
    isBetweenSteps = false,
    refresh?: string,
    timezone?: number,
    customInstanceDetails?: string
  ) {
    const uploadedPicture = picture
      ? picture?.indexOf('imagedelivery.net') > -1
        ? picture
        : await this.storage.uploadSimple(picture).catch((err) => {
            console.log('Failed to upload profile picture:', picture, err);
            return undefined;
          })
      : undefined;

    return this._integrationRepository.createOrUpdateIntegration(
      additionalSettings,
      oneTimeToken,
      org,
      name,
      uploadedPicture,
      type,
      internalId,
      provider,
      token,
      refreshToken,
      expiresIn,
      username,
      isBetweenSteps,
      refresh,
      timezone,
      customInstanceDetails
    );
  }

  updateIntegrationGroup(org: string, id: string, group: string) {
    return this._integrationRepository.updateIntegrationGroup(org, id, group);
  }

  updateOnCustomerName(org: string, id: string, name: string) {
    return this._integrationRepository.updateOnCustomerName(org, id, name);
  }

  getIntegrationsList(org: string) {
    return this._integrationRepository.getIntegrationsList(org);
  }

  getIntegrationForOrder(id: string, order: string, user: string, org: string) {
    return this._integrationRepository.getIntegrationForOrder(
      id,
      order,
      user,
      org
    );
  }

  updateNameAndUrl(id: string, name: string, url: string) {
    return this._integrationRepository.updateNameAndUrl(id, name, url);
  }

  getIntegrationById(org: string, id: string) {
    return this._integrationRepository.getIntegrationById(org, id);
  }

  async refreshToken(provider: SocialProvider, refresh: string) {
    try {
      const { refreshToken, accessToken, expiresIn } =
        await provider.refreshToken(refresh);

      if (!refreshToken || !accessToken || !expiresIn) {
        return false;
      }

      return { refreshToken, accessToken, expiresIn };
    } catch (e) {
      return false;
    }
  }

  async disconnectChannel(orgId: string, integration: Integration, err = '') {
    await this._integrationRepository.disconnectChannel(orgId, integration.id);
    await this.informAboutRefreshError(orgId, integration, err);
  }

  async eraseInstagramStandaloneData(internalId: string, erasePosts = false, issuedAt = 0) {
    const scope = `meta:${createHash('sha256').update(internalId).digest('hex')}:${issuedAt}:${erasePosts}`;
    const previous = await this._integrationRepository.getRemoval(scope);
    const request = previous || await this._integrationRepository.beginRemoval(
      scope, erasePosts ? 'data-deletion' : 'deauthorize',
      (await this._integrationRepository.findInstagramRemovalTargets(internalId))
        .filter(i => !issuedAt || (i.authorizedAt || i.createdAt).getTime() < (issuedAt + 1) * 1000)
    );
    await this.processRemoval(request.id);
    return this._integrationRepository.getRemovalById(request.id);
  }

  async assertActive(integration: Pick<Integration, 'id' | 'organizationId'>) {
    const current = await this.getIntegrationById(integration.organizationId, integration.id);
    if (!current || current.deletedAt || current.disabled || !current.token) {
      throw new HttpException('Channel is disconnected', HttpStatus.GONE);
    }
    return current;
  }

  withActiveIntegration<T>(integration: Pick<Integration, 'id' | 'organizationId'>, action: () => Promise<T>) {
    return withProviderAuthorization(() => this.assertActive(integration), action);
  }

  updateRefreshedCredentials(integration: Integration, accessToken: string, refreshToken?: string, expiresIn?: number, oneTimeToken = false) {
    return this._integrationRepository.updateRefreshedCredentials(integration, accessToken, refreshToken, expiresIn, oneTimeToken);
  }

  async deleteChannelsForAccount(org: string) {
    const request = await this._integrationRepository.getRemoval(`account:${org}`) ||
      await this._integrationRepository.beginRemoval(`account:${org}`, 'data-deletion',
        [], org);
    await this.processRemoval(request.id);
    const result = await this._integrationRepository.getRemovalById(request.id);
    if (result.status === 'pending') throw new HttpException('Account channel cleanup is pending', HttpStatus.SERVICE_UNAVAILABLE);
  }

  getRemovalStatus(id: string) {
    return this._integrationRepository.getRemovalById(id);
  }

  // A durable receipt is created before any cleanup. Failed stages remain
  // retryable, with a strict three-attempt ceiling and no false "completed".
  @Cron('*/1 * * * *')
  async retryPendingRemovals() {
    for (const request of await this._integrationRepository.pendingRemovals()) {
      await this.processRemoval(request.id);
    }
  }

  async processRemoval(id: string) {
    const lockKey = `integration-removal-lock:${id}`;
    const lockValue = createHash('sha256').update(`${id}:${Date.now()}:${Math.random()}`).digest('hex');
    if (!(await ioRedis.set(lockKey, lockValue, 'EX', 300, 'NX'))) return;
    let ownsLock = true;
    const renewal = setInterval(() => {
      ioRedis.eval('if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("expire", KEYS[1], 300) else return 0 end', 1, lockKey, lockValue)
        .then(result => { if (!result) ownsLock = false; }).catch(() => { ownsLock = false; });
    }, 30000);
    renewal.unref();
    try {
      const request = await this._integrationRepository.getRemovalById(id);
      if (!request || request.status !== 'pending' || request.attempts >= 3) return;
      if (!(await this._integrationRepository.claimRemovalAttempt(id)).count) return;
      const targets = request.targets as Array<{ id: string; org: string; picture?: string; posts: string[] }>;
      for (const target of targets) {
        if (!ownsLock) throw new Error('Removal lease lost');
        const client = this._temporalService.client.getRawClient();
        if (!client) throw new Error('Background queue unavailable');
        // The raw database IDs are generated internally, never a search expression supplied by a user.
        if (![target.id, ...target.posts].every(v => /^[A-Za-z0-9_-]+$/.test(v))) {
          throw new Error('Invalid removal target');
        }
        const queries = [`WorkflowId="refresh_${target.id}"`,
          ...target.posts.map(post => `postId="${post}"`)];
        for (const query of queries) {
          for await (const execution of client.workflow.list({ query: `${query} AND ExecutionStatus="Running"` })) {
            try {
              await client.workflow.getHandle(execution.workflowId, execution.runId).terminate('Channel removed');
            } catch (err) {
              if ((err as Error)?.name !== 'WorkflowNotFoundError') throw err;
            }
          }
        }
        const postIds = await this._integrationRepository.eraseChannelRecords(target.org, target.id);
        for (const entityId of new Set([target.id, ...target.posts, ...postIds])) {
          let cursor = '0';
          do {
            const result = await ioRedis.scan(cursor, 'MATCH', `integration:${target.org}:${entityId}:*`, 'COUNT', 100);
            cursor = result[0];
            if (result[1].length) await ioRedis.del(...result[1]);
          } while (cursor !== '0');
        }
        // Imported files can be referenced by other posts/accounts concurrently.
        // Never unlink them based on a non-atomic reference check. Preserve the
        // exact URL in the receipt for the separate, operator-reviewed erasure.
      }
      if (!ownsLock || await ioRedis.get(lockKey) !== lockValue) throw new Error('Removal lease lost');
      await this._integrationRepository.updateRemoval(id, {
        status: request.mode === 'disconnect' ? 'disconnected' : 'active_data_deleted_pending_review',
        targets, lastError: null,
      });
    } catch {
      // Do not persist provider exceptions: their URLs can contain credentials.
      await this._integrationRepository.updateRemoval(id, { lastError: 'Cleanup requires retry or operator review' });
    } finally {
      clearInterval(renewal);
      await ioRedis.eval('if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end', 1, lockKey, lockValue);
    }
  }

  // A reconnect that came back from a different provider (MIGRATE_PROVIDERS):
  // match the disconnected channel by profile and move it to the new provider
  // in place, so scheduled posts, settings and customers survive. Throws the
  // same error as a mismatched reconnect when the migration is not configured
  // or the user connected a different account.
  async migrateIntegration(
    org: string,
    oldInternalId: string,
    newProvider: string,
    auth: { id: string; username: string }
  ) {
    const existing = await this._integrationRepository.getIntegrationByInternalId(
      org,
      oldInternalId
    );

    if (
      !existing ||
      this._integrationManager.getMigrationTarget(
        existing.providerIdentifier
      ) !== newProvider
    ) {
      throw new NotEnoughScopes(
        'Please refresh the channel that needs to be refreshed'
      );
    }

    const oldProvider = this._integrationManager.getSocialIntegration(
      existing.providerIdentifier
    );

    if (!oldProvider.migrationMatch(auth, existing)) {
      throw new NotEnoughScopes(
        `Please connect the same account (@${existing.profile}) that needs to be refreshed`
      );
    }

    if (
      await this._integrationRepository.getIntegrationByInternalId(org, auth.id)
    ) {
      throw new NotEnoughScopes(
        'This account is already connected as another channel, please delete one of them first'
      );
    }

    return this._integrationRepository.migrateIntegration(
      org,
      existing.id,
      auth.id,
      newProvider,
      existing.rootInternalId === existing.internalId
        ? auth.id
        : existing.rootInternalId
    );
  }

  // A fresh connect of a migration target (MIGRATE_PROVIDERS) for an account
  // the org already has on the source provider: adopt that channel instead of
  // creating a confusing duplicate - the channel is migrated in place exactly
  // like a reconnect, and the follow-up upsert stores the fresh tokens. A no-op
  // when nothing matches, so a genuinely new account still creates a channel.
  async migrateIntegrationOnConnect(
    org: string,
    newProvider: string,
    auth: { id: string; username: string }
  ) {
    const sources = this._integrationManager.getMigrationSources(newProvider);
    if (
      !sources.length ||
      this._integrationManager.getSocialIntegration(newProvider).isBetweenSteps
    ) {
      return;
    }

    // the account already exists on the new provider: the normal upsert
    // updates it, nothing to adopt
    if (
      await this._integrationRepository.getIntegrationByInternalId(org, auth.id)
    ) {
      return;
    }

    const existing = (
      await this._integrationRepository.getIntegrationsList(org)
    ).find(
      (p) =>
        sources.includes(p.providerIdentifier) &&
        this._integrationManager
          .getSocialIntegration(p.providerIdentifier)
          .migrationMatch(auth, p)
    );

    if (!existing) {
      return;
    }

    return this._integrationRepository.migrateIntegration(
      org,
      existing.id,
      auth.id,
      newProvider,
      existing.rootInternalId === existing.internalId
        ? auth.id
        : existing.rootInternalId
    );
  }

  async informAboutRefreshError(
    orgId: string,
    integration: Integration,
    err = ''
  ) {
    await this._notificationService.inAppNotification(
      orgId,
      `Could not refresh your ${integration.providerIdentifier} channel ${err}`,
      `Could not refresh your ${integration.providerIdentifier} channel ${err}. Please go back to the system and connect it again ${process.env.FRONTEND_URL}/launches`,
      true,
      false,
      'info'
    );
  }

  async refreshNeeded(org: string, id: string) {
    return this._integrationRepository.refreshNeeded(org, id);
  }

  async setBetweenRefreshSteps(id: string) {
    return this._integrationRepository.setBetweenRefreshSteps(id);
  }

  async refreshTokens() {
    const integrations = await this._integrationRepository.needsToBeRefreshed();
    for (const integration of integrations) {
      await this._refreshIntegrationService.refresh(integration);
    }
  }

  async disableChannel(org: string, id: string) {
    return this._integrationRepository.disableChannel(org, id);
  }

  async enableChannel(org: string, totalChannels: number, id: string) {
    const integrations = (
      await this._integrationRepository.getIntegrationsList(org)
    ).filter((f) => !f.disabled);
    if (
      !!process.env.STRIPE_PUBLISHABLE_KEY &&
      integrations.length >= totalChannels
    ) {
      throw new Error('You have reached the maximum number of channels');
    }

    return this._integrationRepository.enableChannel(org, id);
  }

  async getPostsForChannel(org: string, id: string) {
    return this._integrationRepository.getPostsForChannel(org, id);
  }

  async deleteChannel(org: string, id: string) {
    const integration = await this.getIntegrationById(org, id);
    if (!integration) throw new HttpException('Channel not found', HttpStatus.NOT_FOUND);
    const request = await this._integrationRepository.getRemoval(`channel:${id}`) ||
      await this._integrationRepository.beginRemoval(`channel:${id}`, 'disconnect', [integration]).catch(err => {
        if (err instanceof ChannelAuthorizationChanged) {
          throw new HttpException('This channel was reconnected. Please retry disconnecting it.', HttpStatus.CONFLICT);
        }
        throw err;
      });
    await this.processRemoval(request.id);
    const result = await this._integrationRepository.getRemovalById(request.id);
    if (result.status !== 'disconnected') {
      throw new HttpException('Channel access stopped. Data cleanup is pending; contact support with request ' + request.id,
        HttpStatus.SERVICE_UNAVAILABLE);
    }
    return { success: true, status: 'disconnected', authorizationRevoked: false,
      erasurePendingReview: true, requestId: request.id };
  }

  async disableIntegrations(org: string, totalChannels: number) {
    return this._integrationRepository.disableIntegrations(org, totalChannels);
  }

  async checkForDeletedOnceAndUpdate(org: string, page: string) {
    return this._integrationRepository.checkForDeletedOnceAndUpdate(org, page);
  }

  async saveProviderPage(org: string, id: string, data: any) {
    const getIntegration = await this._integrationRepository.getIntegrationById(
      org,
      id
    );
    if (!getIntegration) {
      throw new HttpException('Integration not found', HttpStatus.NOT_FOUND);
    }
    await this.assertActive(getIntegration);
    if (!getIntegration.inBetweenSteps) {
      throw new HttpException('Invalid request', HttpStatus.BAD_REQUEST);
    }

    const provider = this._integrationManager.getSocialIntegration(
      getIntegration.providerIdentifier
    );

    if (!provider.fetchPageInformation) {
      throw new HttpException(
        'Provider does not support page selection',
        HttpStatus.BAD_REQUEST
      );
    }

    const getIntegrationInformation = await this.withActiveIntegration(getIntegration, () => provider.fetchPageInformation(
      getIntegration.token,
      data
    ));

    await this.checkForDeletedOnceAndUpdate(
      org,
      String(getIntegrationInformation.id)
    );
    await this._integrationRepository.updateIntegration(id, {
      picture: getIntegrationInformation.picture,
      internalId: String(getIntegrationInformation.id),
      organizationId: org,
      name: getIntegrationInformation.name,
      inBetweenSteps: false,
      token: getIntegrationInformation.access_token,
      profile: getIntegrationInformation.username,
    }, getIntegration).catch(err => {
      if (err instanceof ChannelAuthorizationChanged) throw new HttpException('Channel changed. Please reconnect it.', HttpStatus.CONFLICT);
      throw err;
    });

    return { success: true };
  }

  async checkAnalytics(
    org: Organization,
    integration: string,
    date: string,
    forceRefresh = false
  ): Promise<AnalyticsData[]> {
    const getIntegration = await this.getIntegrationById(org.id, integration);

    if (!getIntegration || getIntegration.deletedAt || getIntegration.disabled || !getIntegration.token) {
      throw new Error('Invalid integration');
    }

    if (getIntegration.type !== 'social') {
      return [];
    }

    const integrationProvider = this._integrationManager.getSocialIntegration(
      getIntegration.providerIdentifier
    );

    if (
      dayjs(getIntegration?.tokenExpiration).isBefore(dayjs()) ||
      forceRefresh
    ) {
      const data = await this._refreshIntegrationService.refresh(
        getIntegration
      );
      if (!data) {
        return [];
      }

      const { accessToken } = data;

      if (accessToken) {
        getIntegration.token = accessToken;

        if (integrationProvider.refreshWait) {
          await timer(10000);
        }
      } else {
        await this.disconnectChannel(org.id, getIntegration);
        return [];
      }
    }

    const getIntegrationData = await ioRedis.get(
      `integration:${org.id}:${integration}:${date}`
    );
    if (getIntegrationData) {
      return JSON.parse(getIntegrationData);
    }

    if (integrationProvider.analytics) {
      try {
        await this.assertActive(getIntegration);
        const loadAnalytics = await this.withActiveIntegration(getIntegration, () => integrationProvider.analytics(
          getIntegration.internalId,
          getIntegration.token,
          +date
        ));
        await this.assertActive(getIntegration);
        await ioRedis.set(
          `integration:${org.id}:${integration}:${date}`,
          JSON.stringify(loadAnalytics),
          'EX',
          !process.env.NODE_ENV || process.env.NODE_ENV === 'development'
            ? 1
            : 3600
        );
        try { await this.assertActive(getIntegration); } catch (err) {
          await ioRedis.del(`integration:${org.id}:${integration}:${date}`);
          throw err;
        }
        return loadAnalytics;
      } catch (e) {
        if (e instanceof RefreshToken) {
          return this.checkAnalytics(org, integration, date, true);
        }
      }
    }

    return [];
  }

  customers(orgId: string) {
    return this._integrationRepository.customers(orgId);
  }

  getPlugsByIntegrationId(org: string, integrationId: string) {
    return this._integrationRepository.getPlugsByIntegrationId(
      org,
      integrationId
    );
  }

  async processInternalPlug(
    data: {
      post: string;
      originalIntegration: string;
      integration: string;
      plugName: string;
      orgId: string;
      delay: number;
      information: any;
    },
    forceRefresh = false
  ): Promise<any> {
    const originalIntegration =
      await this._integrationRepository.getIntegrationById(
        data.orgId,
        data.originalIntegration
      );

    const getIntegration = await this._integrationRepository.getIntegrationById(
      data.orgId,
      data.integration
    );

    if (!getIntegration || !originalIntegration || getIntegration.deletedAt ||
        originalIntegration.deletedAt || getIntegration.disabled || originalIntegration.disabled ||
        !getIntegration.token || !originalIntegration.token) {
      return;
    }

    const getAllInternalPlugs = this._integrationManager
      .getInternalPlugs(getIntegration.providerIdentifier)
      .internalPlugs.find((p: any) => p.identifier === data.plugName);

    if (!getAllInternalPlugs) {
      return;
    }

    const getSocialIntegration = this._integrationManager.getSocialIntegration(
      getIntegration.providerIdentifier
    );

    Object.assign(getIntegration, await this.assertActive(getIntegration));
    Object.assign(originalIntegration, await this.assertActive(originalIntegration));
    await withProviderAuthorization(async () => {
      await this.assertActive(getIntegration); await this.assertActive(originalIntegration);
    }, () => getSocialIntegration?.[getAllInternalPlugs.methodName]?.(
      getIntegration,
      originalIntegration,
      data.post,
      data.information
    ));

    return;
  }

  async processPlugs(data: {
    plugId: string;
    postId: string;
    delay: number;
    totalRuns: number;
    currentRun: number;
  }) {
    const getPlugById = await this._integrationRepository.getPlug(data.plugId);
    if (!getPlugById) {
      return true;
    }

    try { Object.assign(getPlugById.integration, await this.assertActive(getPlugById.integration)); }
    catch { return true; }

    const integration = this._integrationManager.getSocialIntegration(
      getPlugById.integration.providerIdentifier
    );

    // @ts-ignore
    const process = await this.withActiveIntegration(getPlugById.integration, () => integration[getPlugById.plugFunction](
      getPlugById.integration,
      data.postId,
      JSON.parse(getPlugById.data).reduce((all: any, current: any) => {
        all[current.name] = current.value;
        return all;
      }, {})
    ));

    if (process) {
      return true;
    }

    if (data.totalRuns === data.currentRun) {
      return true;
    }

    return false;
  }

  async createOrUpdatePlug(
    orgId: string,
    integrationId: string,
    body: PlugDto
  ) {
    const { activated } = await this._integrationRepository.createOrUpdatePlug(
      orgId,
      integrationId,
      body
    );

    return {
      activated,
    };
  }

  async changePlugActivation(orgId: string, plugId: string, status: boolean) {
    const { id, integrationId, plugFunction } =
      await this._integrationRepository.changePlugActivation(
        orgId,
        plugId,
        status
      );

    return { id };
  }

  async getPlugs(orgId: string, integrationId: string) {
    return this._integrationRepository.getPlugs(orgId, integrationId);
  }

  async loadExisingData(
    methodName: string,
    integrationId: string,
    id: string[]
  ) {
    const exisingData = await this._integrationRepository.loadExisingData(
      methodName,
      integrationId,
      id
    );
    const loadOnlyIds = exisingData.map((p) => p.value);
    return difference(id, loadOnlyIds);
  }

  async findFreeDateTime(
    orgId: string,
    integrationsId?: string
  ): Promise<number[]> {
    const findTimes = await this._integrationRepository.getPostingTimes(
      orgId,
      integrationsId
    );
    return uniq(
      findTimes.reduce((all: any, current: any) => {
        return [
          ...all,
          ...JSON.parse(current.postingTimes).map(
            (p: { time: number }) => p.time
          ),
        ];
      }, [] as number[])
    );
  }
}
