/**
 * GoogleOAuthService — тонкий клиент Google OAuth 2.0 для подключения
 * YouTube-канала проекта (этап 61, ТЗ §14.4). Сырой `axios`, без
 * `googleapis` — конвенция проекта (см. youtube-search.service.ts):
 * тонкий REST-клиент вместо тяжёлого SDK ради одной операции.
 *
 * Scope — базовый набор `youtube.upload` (минимально достаточный для
 * `videos.insert`) и `youtube.readonly` (название/аватар канала для UI);
 * расширенный (`+ youtube.force-ssl`, этап 137) просится отдельным
 * действием и только для канала, которому нужны субтитры.
 * `access_type=offline` + `prompt=consent` — иначе Google не выдаст
 * `refresh_token` при повторном согласии того же пользователя.
 */

import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { loadConfiguration } from '../../config/configuration';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels';
/**
 * Базовый набор — минимально достаточный: загрузка ролика и чтение
 * названия с аватаром канала для интерфейса. Просится у всех.
 */
const BASE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

/**
 * Расширенное право (этап 137, ТЗ TZ-Multilingual-YouTube.md §4) —
 * нужно ровно для `captions.insert`, то есть для субтитров.
 *
 * Просится ОТДЕЛЬНЫМ действием и только там, где нужно, а не у всех
 * подряд: скоуп «жирный» — он даёт право не только на субтитры, но и на
 * удаление роликов. Клиенту, которому нужна одна загрузка, показывать
 * на экране согласия «удалять ваши видео» — это и лишний испуг, и
 * лишний разговор с Google на верификации. Мультиязычным делается наш
 * собственный канал (решение владельца 24.09.2026), то есть расширенное
 * согласие нужно ровно одному подключению.
 *
 * Локализованные заголовки и описания сюда НЕ входят: они ставятся при
 * загрузке (`videos.insert` с `part=localizations`) и работают с базовым
 * набором — это и есть главная находка этапа 137.
 */
export const CAPTIONS_SCOPE =
  'https://www.googleapis.com/auth/youtube.force-ssl';

/** Набор прав для ссылки согласия. */
export function googleScopes(extended: boolean): string[] {
  return extended ? [...BASE_SCOPES, CAPTIONS_SCOPE] : [...BASE_SCOPES];
}

/** Есть ли у канала право грузить субтитры. */
export function hasCaptionsScope(scopes: string[] | null | undefined): boolean {
  return (scopes ?? []).includes(CAPTIONS_SCOPE);
}

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

  /**
   * Возврат для проверки подписки («Условно бесплатный Lite», этап
   * 140) — СВОЙ адрес, а не общий с подключением канала: это разные
   * сделки с человеком, и путать их экранами возврата нельзя. Оба
   * адреса должны быть перечислены в консоли Google (см.
   * `doc/DEPLOYMENT.md`).
   */
  private unlockRedirectUri(): string {
    return `${this.cfg().apiPublicUrl.replace(/\/+$/, '')}/referrals/youtube/callback`;
  }

  /**
   * Ссылка согласия ТОЛЬКО на чтение (этап 140). Ни `youtube.upload`,
   * ни `force-ssl`: спрашивать право загружать ролики ради одной
   * проверки подписки — и лишний испуг на экране согласия, и лишний
   * разговор с Google на верификации.
   *
   * `access_type` здесь НЕ `offline` и `prompt` не `consent`: refresh-
   * токен не нужен и не запрашивается — сессия живёт десять минут, и
   * продлевать её нечем даже по ошибке.
   */
  buildUnlockAuthUrl(state: string): string {
    const { googleClientId } = this.cfg();
    const params = new URLSearchParams({
      client_id: googleClientId,
      redirect_uri: this.unlockRedirectUri(),
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/youtube.readonly',
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  /** Обмен кода для проверки подписки — по своему адресу возврата. */
  async exchangeUnlockCode(code: string): Promise<GoogleTokens> {
    return this.exchange(code, this.unlockRedirectUri());
  }

  /**
   * Ссылка на согласие Google — `state` уже подписан вызывающим кодом.
   *
   * `extended` (этап 137) добавляет право на субтитры.
   * `include_granted_scopes=true` — инкрементальная авторизация Google:
   * человек досогласовывает недостающее право, НЕ теряя уже выданных.
   * Без него повторное согласие с одним новым скоупом выдало бы токен
   * ровно с ним — и канал, умевший грузить ролики, перестал бы уметь.
   */
  buildAuthUrl(state: string, extended = false): string {
    const { googleClientId } = this.cfg();
    const params = new URLSearchParams({
      client_id: googleClientId,
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      scope: googleScopes(extended).join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  /** Обмен кода авторизации на access/refresh токены. */
  async exchangeCode(code: string): Promise<GoogleTokens> {
    return this.exchange(code, this.redirectUri());
  }

  /** Общий обмен: отличается только адресом возврата. */
  private async exchange(
    code: string,
    redirectUri: string,
  ): Promise<GoogleTokens> {
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
        redirect_uri: redirectUri,
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
