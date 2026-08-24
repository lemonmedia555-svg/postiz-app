import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import {
  BadBody,
  Disconnect,
  NotEnoughScopes,
  SocialAbstract,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { createHash, randomBytes } from 'crypto';
import FormDataNew from 'form-data';
import mime from 'mime-types';
import { Integration } from '@prisma/client';
import { hasExtension } from '@gitroom/helpers/utils/has.extension';
import { resolve, sep } from 'path';

const VK_API_VERSION = '5.251';
const VK_REQUIRED_PERMISSIONS = {
  photos: 4,
  video: 16,
  wall: 8192,
  groups: 262144,
};

type VkPage = {
  id: string;
  page: string;
  username: string;
  name: string;
  picture: string;
  type: 'profile' | 'community';
};

type VkAttachment = {
  id: string;
  ownerId: string;
  type: 'photo' | 'video';
};

export class VkProvider extends SocialAbstract implements SocialProvider {
  override maxConcurrentJob = 2;
  identifier = 'vk';
  name = 'VK';
  isBetweenSteps = true;
  scopes = [
    'vkid.personal_info',
    'wall',
    'photos',
    'video',
    'groups',
    'offline',
  ];

  editor = 'normal' as const;

  maxLength() {
    return 2048;
  }

  private get redirectUri() {
    return `${
      process?.env.FRONTEND_URL?.indexOf('https') === -1
        ? `https://redirectmeto.com/${process?.env.FRONTEND_URL}`
        : `${process?.env.FRONTEND_URL}`
    }/integrations/social/vk`;
  }

  private addConfidentialAppToken(formData: FormData) {
    if (process.env.VK_SERVICE_TOKEN) {
      formData.append('service_token', process.env.VK_SERVICE_TOKEN);
    }
  }

  private async callVk<T>(
    method: string,
    accessToken: string,
    params: Record<string, string | number> = {}
  ): Promise<T> {
    const body = new URLSearchParams({
      v: VK_API_VERSION,
      access_token: accessToken,
      ...Object.fromEntries(
        Object.entries(params).map(([key, value]) => [key, String(value)])
      ),
    });

    const result = (await (
      await this.fetch(
        `https://api.vk.com/method/${method}`,
        { method: 'POST', body },
        this.identifier
      )
    ).json()) as {
      response?: T;
      error?: { error_code: number; error_msg: string };
    };

    if (result.error) {
      const message = `VK API: ${result.error.error_msg} (${result.error.error_code})`;

      if ([5, 27, 28].includes(result.error.error_code)) {
        throw new Disconnect(
          this.identifier,
          JSON.stringify(result),
          body,
          message
        );
      }

      throw new BadBody(this.identifier, JSON.stringify(result), body, message);
    }

    if (typeof result.response === 'undefined') {
      throw new BadBody(
        this.identifier,
        JSON.stringify(result),
        body,
        `VK API did not return a response for ${method}`
      );
    }

    return result.response;
  }

  private async getVkIdUser(accessToken: string) {
    const formData = new FormData();
    formData.append('client_id', process.env.VK_ID!);
    formData.append('access_token', accessToken);

    const result = (await (
      await this.fetch(
        'https://id.vk.com/oauth2/user_info',
        { method: 'POST', body: formData },
        this.identifier
      )
    ).json()) as {
      user?: {
        user_id: string;
        first_name: string;
        last_name: string;
        avatar?: string;
      };
      error?: string;
      error_description?: string;
    };

    if (!result.user) {
      throw new NotEnoughScopes(
        result.error_description ||
          result.error ||
          'VK did not return the user profile'
      );
    }

    return result.user;
  }

  private async ensurePublishingPermissions(accessToken: string) {
    let permissions: number;

    try {
      permissions = await this.callVk<number>(
        'account.getAppPermissions',
        accessToken
      );
    } catch {
      throw new NotEnoughScopes(
        'Приложению VK не выданы права на публикацию. Нужны доступы wall, photos, video и groups.'
      );
    }

    const missing = Object.entries(VK_REQUIRED_PERMISSIONS)
      .filter(([, bit]) => (permissions & bit) !== bit)
      .map(([scope]) => scope);

    if (missing.length) {
      throw new NotEnoughScopes(
        `Приложению VK не хватает прав: ${missing.join(', ')}.`
      );
    }
  }

  async refreshToken(refresh: string): Promise<AuthTokenDetails> {
    const [oldRefreshToken, deviceId] = refresh.split('&&&&');
    const formData = new FormData();
    formData.append('grant_type', 'refresh_token');
    formData.append('refresh_token', oldRefreshToken);
    formData.append('client_id', process.env.VK_ID!);
    formData.append('device_id', deviceId);
    formData.append('state', makeId(32));
    formData.append('scope', this.scopes.join(' '));
    this.addConfidentialAppToken(formData);

    const tokenResult = (await (
      await this.fetch(
        'https://id.vk.com/oauth2/auth',
        { method: 'POST', body: formData },
        this.identifier
      )
    ).json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };

    if (!tokenResult.access_token || !tokenResult.refresh_token) {
      throw new Disconnect(
        this.identifier,
        JSON.stringify(tokenResult),
        formData,
        tokenResult.error_description ||
          tokenResult.error ||
          'VK token refresh failed'
      );
    }

    const user = await this.getVkIdUser(tokenResult.access_token);
    await this.ensurePublishingPermissions(tokenResult.access_token);

    return {
      id: String(user.user_id),
      name: `${user.first_name} ${user.last_name}`,
      accessToken: tokenResult.access_token,
      refreshToken: `${tokenResult.refresh_token}&&&&${deviceId}`,
      expiresIn: tokenResult.expires_in || 0,
      picture: user.avatar || '',
      username: String(user.user_id),
    };
  }

  async generateAuthUrl() {
    if (!process.env.VK_ID) {
      throw new Error('VK_ID is not configured');
    }

    const state = makeId(32);
    const codeVerifier = randomBytes(64).toString('base64url');
    const challenge = Buffer.from(
      createHash('sha256').update(codeVerifier).digest()
    )
      .toString('base64')
      .replace(/=*$/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    const query = new URLSearchParams({
      response_type: 'code',
      client_id: process.env.VK_ID,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      redirect_uri: this.redirectUri,
      state,
      scope: this.scopes.join(' '),
    });

    return {
      url: `https://id.vk.com/authorize?${query.toString()}`,
      codeVerifier,
      state,
    };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    const [code, deviceId] = params.code.split('&&&&');

    if (!code || !deviceId) {
      throw new NotEnoughScopes('VK did not return an authorization code');
    }

    const formData = new FormData();
    formData.append('client_id', process.env.VK_ID!);
    formData.append('grant_type', 'authorization_code');
    formData.append('code_verifier', params.codeVerifier);
    formData.append('device_id', deviceId);
    formData.append('code', code);
    formData.append('redirect_uri', this.redirectUri);
    this.addConfidentialAppToken(formData);

    const tokenResult = (await (
      await this.fetch(
        'https://id.vk.com/oauth2/auth',
        { method: 'POST', body: formData },
        this.identifier
      )
    ).json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };

    if (!tokenResult.access_token || !tokenResult.refresh_token) {
      throw new NotEnoughScopes(
        tokenResult.error_description ||
          tokenResult.error ||
          'VK token exchange failed'
      );
    }

    const user = await this.getVkIdUser(tokenResult.access_token);
    await this.ensurePublishingPermissions(tokenResult.access_token);

    return {
      // A temporary id prevents a second community connection from replacing
      // an already connected personal VK profile before page selection.
      id: `vk-auth-${user.user_id}-${makeId(12)}`,
      name: `${user.first_name} ${user.last_name}`,
      accessToken: tokenResult.access_token,
      refreshToken: `${tokenResult.refresh_token}&&&&${deviceId}`,
      expiresIn: tokenResult.expires_in || 0,
      picture: user.avatar || '',
      username: String(user.user_id),
    };
  }

  async pages(accessToken: string): Promise<VkPage[]> {
    const [users, groups] = await Promise.all([
      this.callVk<
        {
          id: number;
          first_name: string;
          last_name: string;
          screen_name?: string;
          photo_200?: string;
        }[]
      >('users.get', accessToken, {
        fields: 'screen_name,photo_200',
      }),
      this.callVk<{
        items: {
          id: number;
          name: string;
          screen_name: string;
          photo_200?: string;
        }[];
      }>('groups.get', accessToken, {
        extended: 1,
        filter: 'admin,editor',
        fields: 'screen_name,photo_200',
      }),
    ]);

    const profile = users[0];
    const profilePage: VkPage[] = profile
      ? [
          {
            id: String(profile.id),
            page: String(profile.id),
            username: profile.screen_name || `id${profile.id}`,
            name: `${profile.first_name} ${profile.last_name}`,
            picture: profile.photo_200 || '',
            type: 'profile',
          },
        ]
      : [];

    const communities: VkPage[] = (groups.items || []).map((group) => ({
      id: String(-group.id),
      page: String(-group.id),
      username: group.screen_name || `club${group.id}`,
      name: group.name,
      picture: group.photo_200 || '',
      type: 'community',
    }));

    return [...profilePage, ...communities];
  }

  async fetchPageInformation(accessToken: string, data: { page: string }) {
    const availablePages = await this.pages(accessToken);
    const selected = availablePages.find(
      (page) => page.page === String(data.page)
    );

    if (!selected) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        'The selected VK page is not available for this user'
      );
    }

    return {
      id: selected.id,
      name: selected.name,
      access_token: accessToken,
      picture: selected.picture,
      username: selected.username,
    };
  }

  async reConnect(id: string, requiredId: string, accessToken: string) {
    const page = await this.fetchPageInformation(accessToken, {
      page: requiredId,
    });

    return {
      id: page.id,
      name: page.name,
      accessToken: page.access_token,
      picture: page.picture,
      username: page.username,
    };
  }

  private getReadableMediaPath(mediaPath: string) {
    const uploadRoot = resolve(process.env.UPLOAD_DIRECTORY || '/uploads');

    if (mediaPath.startsWith('uploads/')) {
      const localPath = resolve(uploadRoot, mediaPath.slice('uploads/'.length));
      return localPath.startsWith(`${uploadRoot}${sep}`)
        ? localPath
        : mediaPath;
    }

    if (!mediaPath.startsWith('http') || !process.env.FRONTEND_URL) {
      return mediaPath;
    }

    try {
      const mediaUrl = new URL(mediaPath);
      const frontendUrl = new URL(process.env.FRONTEND_URL);

      if (
        mediaUrl.origin !== frontendUrl.origin ||
        !mediaUrl.pathname.startsWith('/uploads/')
      ) {
        return mediaPath;
      }

      const relativePath = decodeURIComponent(
        mediaUrl.pathname.slice('/uploads/'.length)
      );
      const localPath = resolve(uploadRoot, relativePath);

      return localPath.startsWith(`${uploadRoot}${sep}`)
        ? localPath
        : mediaPath;
    } catch {
      return mediaPath;
    }
  }

  private async uploadMedia(
    ownerId: string,
    accessToken: string,
    post: PostDetails
  ): Promise<VkAttachment[]> {
    const groupId = ownerId.startsWith('-') ? ownerId.slice(1) : undefined;

    return Promise.all(
      (post?.media || []).map(async (media) => {
        const isVideo =
          media.type === 'video' || hasExtension(media.path, 'mp4');
        const uploadData: {
          upload_url: string;
          owner_id?: number;
          video_id?: number;
        } = isVideo
          ? await this.callVk<{
              upload_url: string;
              owner_id: number;
              video_id: number;
            }>('video.save', accessToken, {
              ...(groupId ? { group_id: groupId } : {}),
              name: media.path.split('/').at(-1) || 'video',
            })
          : await this.callVk<{ upload_url: string }>(
              'photos.getWallUploadServer',
              accessToken,
              groupId ? { group_id: groupId } : {}
            );

        const filename = media.path.split('/').at(-1) || 'media';
        const readableMediaPath = this.getReadableMediaPath(media.path);
        const fileSize = await this.mediaSize(
          readableMediaPath,
          this.identifier
        );

        const uploadResponse = await this.runStreamedUpload(async () => {
          // A retry needs a fresh stream because an already-read stream cannot
          // be sent for a second time.
          const formData = new FormDataNew();
          formData.append(
            isVideo ? 'video_file' : 'photo',
            await this.mediaStream(readableMediaPath, this.identifier),
            {
              filename,
              contentType: mime.lookup(filename) || undefined,
              knownLength: fileSize,
            }
          );

          const { data } = await this.getSsrfSafeAxios().post(
            uploadData.upload_url,
            formData,
            {
              headers: formData.getHeaders(),
              maxBodyLength: Infinity,
              maxContentLength: Infinity,
            }
          );
          return data;
        }, this.identifier);

        if (isVideo) {
          if (
            typeof uploadData.video_id === 'undefined' ||
            typeof uploadData.owner_id === 'undefined'
          ) {
            throw new BadBody(
              this.identifier,
              JSON.stringify(uploadData),
              '{}',
              'VK did not prepare the video upload'
            );
          }

          return {
            id: String(uploadData.video_id),
            ownerId: String(uploadData.owner_id),
            type: 'video' as const,
          };
        }

        const [photo] = await this.callVk<{ id: number; owner_id: number }[]>(
          'photos.saveWallPhoto',
          accessToken,
          {
            photo: uploadResponse.photo,
            server: uploadResponse.server,
            hash: uploadResponse.hash,
            ...(groupId ? { group_id: groupId } : {}),
          }
        );

        if (!photo) {
          throw new BadBody(
            this.identifier,
            JSON.stringify(uploadResponse),
            '{}',
            'VK did not save the uploaded photo'
          );
        }

        return {
          id: String(photo.id),
          ownerId: String(photo.owner_id),
          type: 'photo' as const,
        };
      })
    );
  }

  async post(
    ownerId: string,
    accessToken: string,
    postDetails: PostDetails[]
  ): Promise<PostResponse[]> {
    const [firstPost] = postDetails;
    const mediaList = await this.uploadMedia(ownerId, accessToken, firstPost);

    const response = await this.callVk<{ post_id: number }>(
      'wall.post',
      accessToken,
      {
        owner_id: ownerId,
        ...(ownerId.startsWith('-') ? { from_group: 1 } : {}),
        message: firstPost.message,
        ...(mediaList.length
          ? {
              attachments: mediaList
                .map((item) => `${item.type}${item.ownerId}_${item.id}`)
                .join(','),
            }
          : {}),
      }
    );

    return [
      {
        id: firstPost.id,
        postId: String(response.post_id),
        releaseURL: `https://vk.com/wall${ownerId}_${response.post_id}`,
        status: 'completed',
      },
    ];
  }

  async comment(
    ownerId: string,
    postId: string,
    lastCommentId: string | undefined,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [commentPost] = postDetails;
    const mediaList = await this.uploadMedia(ownerId, accessToken, commentPost);

    const response = await this.callVk<{ comment_id: number }>(
      'wall.createComment',
      accessToken,
      {
        owner_id: ownerId,
        post_id: postId,
        message: commentPost.message,
        ...(mediaList.length
          ? {
              attachments: mediaList
                .map((item) => `${item.type}${item.ownerId}_${item.id}`)
                .join(','),
            }
          : {}),
      }
    );

    return [
      {
        id: commentPost.id,
        postId: String(response.comment_id),
        releaseURL: `https://vk.com/wall${ownerId}_${postId}`,
        status: 'completed',
      },
    ];
  }
}
