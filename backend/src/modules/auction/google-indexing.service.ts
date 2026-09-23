/**
 * GoogleIndexingService — Этап 6 (docs-tz/TZ-Virtualnaya-Studiya-i-AI-
 * Vedushaya.md §7.8) — тонкий клиент Google Indexing API, единственная
 * задача: сообщить Google «перекраулить вот этот URL прямо сейчас»
 * (`URL_UPDATED`) в момент старта/конца живого эфира лота, чтобы
 * разметка `BroadcastEvent` (JSON-LD на странице маркетплейса,
 * `marketplace/src/app/[locale]/auctions/[id]/page.tsx`) была видна
 * Google именно пока эфир идёт — не часами позже.
 *
 * ## Официальная область применения — и почему здесь это законно
 *
 * Indexing API официально поддерживает только страницы с разметкой
 * `JobPosting` либо `BroadcastEvent` (см. `AUDIT-Live-Auction-Google-
 * Indexing-API.md` §1–2) — вызовы для произвольных страниц технически
 * не отклоняются на лету, но это открытое злоупотребление API не по
 * назначению, за которое рынок регулярно получает домен на ручную
 * проверку. Здесь — не тот случай: страница лота в фазе эфира БУКВАЛЬНО
 * является прямой трансляцией (реальное видео, реальные метки начала/
 * конца), то есть честное применение по прямому назначению. Это не
 * снимает ответственности: сервис вызывается ТОЛЬКО из точек жизненного
 * цикла эфира (см. вызывающих ниже), никогда — для обычных страниц лота.
 *
 * ## Одобрение продакшн-использования (внешняя зависимость, не код)
 *
 * С 2024 года дефолтная квота (200 publish/сутки) — тестовая; чтобы
 * вызовы реально доходили до краулера в проде, нужно отдельное
 * одобрение через заявку на увеличение квоты в Google Cloud Console
 * (см. `AUDIT-Live-Auction-Google-Indexing-API.md` §3). Этот сервис
 * технически рабочий и без одобрения (вернёт `res.ok`), но реального
 * эффекта до одобрения может не быть — это не проверяется кодом,
 * подать заявку — организационный шаг, не зависящий от разработки.
 *
 * ## Fail-safe по тому же принципу, что GoogleAdsService
 *
 * `isConfigured()` проверяет обязательные переменные окружения; при их
 * отсутствии (или `GOOGLE_INDEXING_ENABLED !== 'true'`) `notify()` не
 * делает ни одного сетевого вызова — сразу возвращает `false`. Ни один
 * вызывающий (`LiveAuctionOrchestratorService`, `AuctionService`) не
 * зависит от результата — сбой сети, просроченный ключ или отсутствие
 * credentials не должны ронять сам жизненный цикл эфира/аукциона:
 * индексация — бонус, не условие работы эфира.
 *
 * ## Аутентификация без внешних библиотек
 *
 * Service account JWT (RS256), подписанный `crypto.createSign` —
 * тот же приём, что уже использует SilverFinance для точно той же
 * задачи (см. их `googleIndexing.ts`, найдено при сверке §7.8), а не
 * `googleapis`/`google-auth-library`: тот же принцип, что у
 * GoogleAdsService/HedraClientService — тонкий HTTP-клиент без тяжёлой
 * SDK-зависимости, которую в этой песочнице всё равно нельзя
 * установить (`npm install` не проходит, см. другие аудиты).
 */

import { Injectable, Logger } from '@nestjs/common';
import { createSign } from 'crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PUBLISH_URL =
  'https://indexing.googleapis.com/v3/urlNotifications:publish';
const SCOPE = 'https://www.googleapis.com/auth/indexing';
/** Токен живёт час (Google) — перевыпускаем на минуту раньше срока, чтобы не словить его протухшим прямо в момент запроса. */
const TOKEN_REFRESH_SLACK_MS = 60_000;

export type IndexingNotifyType = 'URL_UPDATED' | 'URL_DELETED';

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

@Injectable()
export class GoogleIndexingService {
  private readonly logger = new Logger(GoogleIndexingService.name);

  // Кеш access-токена в памяти процесса — тот же приём, что у SilverFinance:
  // на serverless-функции кеш живёт ровно до следующего холодного старта,
  // это не проблема (токен всё равно на час, а не навсегда), просто не
  // экономит между инстансами.
  private cachedToken: { token: string; exp: number } | null = null;

  /** Пять обязательных переменных: без них ни один вызов не уйдёт в сеть. */
  isConfigured(): boolean {
    return (
      process.env.GOOGLE_INDEXING_ENABLED === 'true' &&
      Boolean(process.env.GOOGLE_INDEXING_SA_EMAIL) &&
      Boolean(process.env.GOOGLE_INDEXING_SA_PRIVATE_KEY)
    );
  }

  /**
   * Сообщить Google, что URL изменился/исчез — best-effort, никогда не
   * бросает исключений (вызывающие — `LiveAuctionOrchestratorService`/
   * `AuctionService` — уже сами best-effort и не должны падать из-за
   * сети/квоты Google). Возвращает `true` только при успешном HTTP 2xx
   * от Google — вызывающие это значение сейчас нигде не проверяют
   * строго (сама индексация не может быть условием бизнес-логики), но
   * оно полезно для логов/будущей телеметрии.
   */
  async notify(
    url: string,
    type: IndexingNotifyType = 'URL_UPDATED',
  ): Promise<boolean> {
    if (!this.isConfigured() || !url) return false;
    const token = await this.getAccessToken();
    if (!token) return false;
    try {
      const res = await fetch(PUBLISH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ url, type }),
      });
      if (!res.ok) {
        this.logger.warn(
          `Indexing API ${res.status} for ${url}: ${(await res.text().catch(() => '')).slice(0, 300)}`,
        );
      }
      return res.ok;
    } catch (error) {
      this.logger.warn(
        `Indexing API request failed for ${url}: ${this.extractErrorMessage(error)}`,
      );
      return false;
    }
  }

  private async getAccessToken(): Promise<string | null> {
    if (
      this.cachedToken &&
      Date.now() < this.cachedToken.exp - TOKEN_REFRESH_SLACK_MS
    ) {
      return this.cachedToken.token;
    }

    const email = process.env.GOOGLE_INDEXING_SA_EMAIL;
    // PEM обычно хранится в env с экранированными переносами строк (\n
    // буквально, не настоящий перевод строки) — разэкранируем, тот же
    // приём, что уже используется в проекте для других PEM-ключей.
    const privateKey = process.env.GOOGLE_INDEXING_SA_PRIVATE_KEY?.replace(
      /\\n/g,
      '\n',
    );
    if (!email || !privateKey) return null;

    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = base64url(
      JSON.stringify({
        iss: email,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600,
      }),
    );
    const signingInput = `${header}.${claim}`;

    let signature: string;
    try {
      const signer = createSign('RSA-SHA256');
      signer.update(signingInput);
      signer.end();
      signature = base64url(signer.sign(privateKey));
    } catch (error) {
      this.logger.warn(
        `GOOGLE_INDEXING_SA_PRIVATE_KEY не удалось использовать для подписи JWT: ${this.extractErrorMessage(error)}`,
      );
      return null;
    }
    const assertion = `${signingInput}.${signature}`;

    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }),
      });
      if (!res.ok) {
        this.logger.warn(
          `OAuth token exchange ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`,
        );
        return null;
      }
      const data = (await res.json()) as {
        access_token?: string;
        expires_in?: number;
      };
      if (!data.access_token) return null;
      this.cachedToken = {
        token: data.access_token,
        exp: Date.now() + (data.expires_in ?? 3600) * 1000,
      };
      return data.access_token;
    } catch (error) {
      this.logger.warn(
        `OAuth token exchange failed: ${this.extractErrorMessage(error)}`,
      );
      return null;
    }
  }

  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return 'Unknown error';
  }
}
