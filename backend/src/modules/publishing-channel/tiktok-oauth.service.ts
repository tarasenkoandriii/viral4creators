/**
 * TiktokOAuthService — тонкий клиент TikTok Login Kit OAuth 2.0 (этап 61,
 * ТЗ §14.4). Тот же принцип, что у GoogleOAuthService: сырой `axios`, без
 * SDK. Scope `video.publish` — единственный, нужный Content Posting API.
 */

import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { loadConfiguration } from '../../config/configuration';

const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const USER_INFO_URL = 'https://open.tiktokapis.com/v2/user/info/';
const SCOPE = 'video.publish';

export interface TiktokTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
}

export interface TiktokChannelInfo {
  externalId: string;
  title: string;
  avatarUrl: string | null;
}

@Injectable()
export class TiktokOAuthService {
  private readonly logger = new Logger(TiktokOAuthService.name);

  private cfg() {
    return loadConfiguration().publishing;
  }

  configured(): boolean {
    const { tiktokClientKey, tiktokClientSecret, apiPublicUrl } = this.cfg();
    return !!(tiktokClientKey && tiktokClientSecret && apiPublicUrl);
  }

  private redirectUri(): string {
    return `${this.cfg().apiPublicUrl.replace(/\/+$/, '')}/channels/oauth/TIKTOK/callback`;
  }

  buildAuthUrl(state: string): string {
    const { tiktokClientKey } = this.cfg();
    const params = new URLSearchParams({
      client_key: tiktokClientKey,
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      scope: SCOPE,
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<TiktokTokens> {
    const { tiktokClientKey, tiktokClientSecret } = this.cfg();
    const res = await axios.post<{
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope: string;
    }>(
      TOKEN_URL,
      new URLSearchParams({
        client_key: tiktokClientKey,
        client_secret: tiktokClientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: this.redirectUri(),
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    return {
      accessToken: res.data.access_token,
      refreshToken: res.data.refresh_token ?? null,
      expiresAt: new Date(Date.now() + res.data.expires_in * 1000),
      scopes: res.data.scope.split(',').filter(Boolean),
    };
  }

  async refreshAccessToken(
    refreshToken: string,
  ): Promise<{ accessToken: string; expiresAt: Date }> {
    const { tiktokClientKey, tiktokClientSecret } = this.cfg();
    const res = await axios.post<{ access_token: string; expires_in: number }>(
      TOKEN_URL,
      new URLSearchParams({
        client_key: tiktokClientKey,
        client_secret: tiktokClientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    return {
      accessToken: res.data.access_token,
      expiresAt: new Date(Date.now() + res.data.expires_in * 1000),
    };
  }

  async fetchChannelInfo(accessToken: string): Promise<TiktokChannelInfo> {
    const res = await axios.get<{
      data?: {
        user?: {
          open_id: string;
          display_name: string;
          avatar_url?: string;
        };
      };
    }>(USER_INFO_URL, {
      params: { fields: 'open_id,display_name,avatar_url' },
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const user = res.data.data?.user;
    if (!user) {
      throw new Error(
        'TikTok не вернул данные аккаунта — попробуйте подключить канал ещё раз',
      );
    }
    return {
      externalId: user.open_id,
      title: user.display_name,
      avatarUrl: user.avatar_url ?? null,
    };
  }

  /** Best-effort — TikTok Login Kit не предоставляет отдельный revoke-эндпоинт
   * для сторонних приложений; отключение канала просто перестаёт хранить токен.
   * Параметр не используется — сигнатура зеркалит GoogleOAuthService.revoke,
   * чтобы оба провайдера вызывались одинаково через общий union-тип. */
  async revoke(accessToken?: string): Promise<void> {
    void accessToken; // см. комментарий выше — сигнатура зеркалит Google
    this.logger.debug(
      'TikTok: явного revoke-эндпоинта нет, локальный токен удаляется без обращения к API',
    );
  }
}
