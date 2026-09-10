/**
 * GoogleOAuthService — тонкий клиент Google OAuth 2.0 для подключения
 * YouTube-канала проекта (этап 61, ТЗ §14.4). Сырой `axios`, без
 * `googleapis` — конвенция проекта (см. youtube-search.service.ts):
 * тонкий REST-клиент вместо тяжёлого SDK ради одной операции.
 *
 * Scope — только `youtube.upload` (минимально достаточный для
 * `videos.insert`) и `youtube.readonly` (название/аватар канала для UI).
 * `access_type=offline` + `prompt=consent` — иначе Google не выдаст
 * `refresh_token` при повторном согласии того же пользователя.
 */

import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { loadConfiguration } from '../../config/configuration';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels';
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
].join(' ');

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
}

export interface GoogleChannelInfo {
  externalId: string;
  title: string;
  avatarUrl: string | null;
}

@Injectable()
export class GoogleOAuthService {
  private readonly logger = new Logger(GoogleOAuthService.name);

  private cfg() {
    return loadConfiguration().publishing;
  }

  configured(): boolean {
    const { googleClientId, googleClientSecret, apiPublicUrl } = this.cfg();
    return !!(googleClientId && googleClientSecret && apiPublicUrl);
  }

  private redirectUri(): string {
    return `${this.cfg().apiPublicUrl.replace(/\/+$/, '')}/channels/oauth/YOUTUBE/callback`;
  }

  /** Ссылка на согласие Google — `state` уже подписан вызывающим кодом. */
  buildAuthUrl(state: string): string {
    const { googleClientId } = this.cfg();
    const params = new URLSearchParams({
      client_id: googleClientId,
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  /** Обмен кода авторизации на access/refresh токены. */
  async exchangeCode(code: string): Promise<GoogleTokens> {
    const { googleClientId, googleClientSecret } = this.cfg();
    const res = await axios.post<{
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope: string;
    }>(
      TOKEN_URL,
      new URLSearchParams({
        code,
        client_id: googleClientId,
        client_secret: googleClientSecret,
        redirect_uri: this.redirectUri(),
        grant_type: 'authorization_code',
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    return {
      accessToken: res.data.access_token,
      refreshToken: res.data.refresh_token ?? null,
      expiresAt: new Date(Date.now() + res.data.expires_in * 1000),
      scopes: res.data.scope.split(' ').filter(Boolean),
    };
  }

  /** Ленивое обновление access-токена перед выгрузкой (§14.4). Бросает,
   * если refresh-токен отозван — вызывающий переводит канал в REVOKED. */
  async refreshAccessToken(
    refreshToken: string,
  ): Promise<{ accessToken: string; expiresAt: Date }> {
    const { googleClientId, googleClientSecret } = this.cfg();
    const res = await axios.post<{ access_token: string; expires_in: number }>(
      TOKEN_URL,
      new URLSearchParams({
        refresh_token: refreshToken,
        client_id: googleClientId,
        client_secret: googleClientSecret,
        grant_type: 'refresh_token',
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    return {
      accessToken: res.data.access_token,
      expiresAt: new Date(Date.now() + res.data.expires_in * 1000),
    };
  }

  /** Название/аватар канала — только для UI списка подключённых каналов. */
  async fetchChannelInfo(accessToken: string): Promise<GoogleChannelInfo> {
    const res = await axios.get<{
      items?: Array<{
        id: string;
        snippet: { title: string; thumbnails?: { default?: { url: string } } };
      }>;
    }>(CHANNELS_URL, {
      params: { part: 'snippet', mine: 'true' },
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const channel = res.data.items?.[0];
    if (!channel) {
      throw new Error(
        'У аккаунта Google нет ни одного YouTube-канала — создайте канал перед подключением',
      );
    }
    return {
      externalId: channel.id,
      title: channel.snippet.title,
      avatarUrl: channel.snippet.thumbnails?.default?.url ?? null,
    };
  }

  /** Best-effort — отзыв гранта у Google при отключении канала. */
  async revoke(accessToken: string): Promise<void> {
    try {
      await axios.post(
        'https://oauth2.googleapis.com/revoke',
        new URLSearchParams({ token: accessToken }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Не удалось отозвать грант Google: ${message}`);
    }
  }
}
