/**
 * GoogleAdsService — реальный REST-клиент Google Ads API (ТЗ на
 * маркетплейс §22, «Google Ads для блиц-лотов») — закрывает Этап 5,
 * оставшийся открытым после Этапа 4 (см. `marketplace/.../auctions/
 * feed/google-ads.xml/route.ts`, который отдаёт только ДАННЫЕ фида, но
 * прямо документирует, что сам вызов API — отдельный шаг).
 *
 * Прямой REST (`googleads.googleapis.com/{version}`), а не официальный
 * Node-клиент `google-ads-api` (обёртка над gRPC) — тот же принцип, что
 * у FfmpegApiService/HedraClientService: тонкий HTTP-клиент, который
 * можно прочитать целиком, без тяжёлой gRPC-зависимости, которую в этой
 * песочнице всё равно нельзя ни установить (`npm install` не проходит,
 * см. другие аудиты), ни протестировать живым вызовом.
 *
 * ## Fail-safe по требованию (нет ни одного Google Ads credential в
 * проекте — developer token выдаётся Google вручную по заявке, обычно
 * дни): `isConfigured()` проверяет пять обязательных переменных
 * окружения (см. ниже), и при их отсутствии `createBlitzCampaign`/
 * `pauseCampaign` не делают ни одного сетевого вызова — просто пишут
 * debug-лог и возвращают `null`/ничего не делают. Ни промоушен лота в
 * ACTIVE (`AuctionService.promoteNextQueued`), ни закрытие лота не
 * зависят от готовности Google Ads — это осознанно best-effort слой:
 * если он сломается или не настроен, основной аукционный цикл (ставки,
 * оплата, SOLD) работает как раньше, без него.
 *
 * ## Честная граница того, что этот код реально может
 *
 * Даже с настоящими credentials создание Performance Max кампании через
 * API не гарантирует, что она реально начнёт показываться:
 *
 * 1. **Цели конверсий** — Performance Max требует хотя бы одну настроенную
 *    conversion action на уровне аккаунта (см. developers.google.com/
 *    google-ads/api/performance-max/create-campaign) — это отдельная,
 *    ручная настройка аккаунта, вне зоны ответственности этого кода.
 *    Без неё вызов создания кампании, скорее всего, завершится ошибкой
 *    Google — она перехватывается и логируется, лот всё равно остаётся
 *    ACTIVE на самой витрине (реклама — бонус, не условие продажи).
 * 2. **Изображения.** Здесь два РАЗНЫХ порога, которые легко спутать.
 *    Сам API принимает asset group с ОДНИМ горизонтальным (1.91:1) и
 *    одним квадратным (1:1) изображением — столько и отправляется, и по
 *    этой причине группа не отклоняется. Но справка Google
 *    (support.google.com/google-ads/answer/17091269) считает объявление
 *    неполным по ad strength, пока в нём меньше ЧЕТЫРЁХ изображений
 *    каждого из двух форматов. У нас на лот есть единственный
 *    `thumbnailUrl`, он прикладывается в оба слота — значит кампания
 *    создастся, но до полного показа её придётся доводить вручную через
 *    кабинет Google Ads. Видео-ассеты не прикладываются вовсе: Google
 *    принимает только видео, уже загруженное на YouTube
 *    (`videoAsset.youtubeVideoId`), а наши ролики лежат в Vercel Blob;
 *    добавить YouTube-загрузку — отдельная интеграция (YouTube Data
 *    API, свой OAuth-скоуп), не входит в этот проход.
 * 3. **Brand guidelines и обязательные ассеты бренда.** Прежняя версия
 *    этого комментария утверждала, что `brandGuidelinesEnabled: false`
 *    избавляет от `BUSINESS_NAME`/`LOGO`. Это неверно, и сверка с
 *    документацией (сентябрь 2026) показала обратное: выключение не
 *    убирает эти ассеты, а ПЕРЕНОСИТ их с уровня кампании
 *    (`CampaignAsset`) на уровень asset group (`AssetGroupAsset`).
 *    Обязательны они в любом случае — ровно один `BUSINESS_NAME` и хотя
 *    бы один `LOGO` 1:1. С v21 Google включает brand guidelines новым
 *    PMax-кампаниям по умолчанию, поэтому поле задаётся явно.
 *    Отправляются оба: `BUSINESS_NAME` — константой, `LOGO` — картинкой
 *    по ссылке из `GOOGLE_ADS_LOGO_URL`. Логотип один на аккаунт, а не
 *    на лот, поэтому его ассет кешируется в памяти процесса — иначе
 *    каждая кампания заводила бы в аккаунте ещё одну копию той же
 *    картинки. Файл проверяется на квадратность ДО отправки (Google
 *    принимает `LOGO` только 1:1): неквадратный не отправляется вовсе,
 *    формат, который не разобрался, отправляется как есть — решать
 *    Google, а не нашему парсеру заголовков.
 *
 *    Без `GOOGLE_ADS_LOGO_URL` поведение прежнее: логотип не уходит,
 *    в лог пишется предупреждение, кампания всё равно создаётся (она и
 *    так создаётся `PAUSED`), но asset group остаётся неполной по
 *    меркам API и включение на шаге 6, скорее всего, не пройдёт.
 * 4. **Бюджет** — `amountMicros` в валюте самого рекламного аккаунта, а
 *    НЕ в `AuctionListing.payoutCurrency` (это разные вещи — валюта
 *    выплаты исполнителю и валюта биллинга рекламного кабинета никак не
 *    связаны). Дефолт в `GOOGLE_ADS_BLITZ_DAILY_BUDGET_MICROS` —
 *    заведомо условный плейсхолдер, ОБЯЗАТЕЛЬНО пересмотреть под
 *    реальную валюту и бюджет аккаунта перед первым реальным включением.
 * 5. **Версия API.** Прежде здесь было захардкожено `v18` — версия,
 *    отключённая Google 20 августа 2025 года, то есть все запросы этого
 *    клиента падали независимо от остального. Дефолт поднят до `v25`
 *    (актуальная на сентябрь 2026) и вынесен в
 *    `GOOGLE_ADS_API_VERSION`: Google снимает версии примерно через год
 *    (v22 отключается 7 октября 2026), и следующий сдвиг не должен
 *    требовать правки кода.
 * 6. **Ничего из этого не проверено живым вызовом.** В этой песочнице
 *    нет ни сетевого доступа к googleads.googleapis.com, ни тестовых
 *    credentials. Структура запросов и все числа выше сверены с
 *    официальной документацией (`performance-max/asset-requirements`,
 *    `performance-max/create-campaign`, пример `add-performance-max-
 *    campaign`, support-статья 17091269) в сентябре 2026 — но сверка с
 *    документацией не равна работающему вызову. Перед первым реальным
 *    включением стоит прогнать создание кампании на тестовом аккаунте.
 *
 * Из-за (1)–(3) кампания создаётся в статусе `PAUSED` и включается
 * (`ENABLED`) отдельным вызовом только после того, как asset group
 * собран — если Google на этом шаге всё же откажет, кампания остаётся
 * `PAUSED` (безопасный дефолт: деньги не тратятся на заведомо неполную
 * кампанию), но `googleAdsCampaignId` всё равно сохраняется — оператор
 * видит её в кабинете Google Ads и может донастроить вручную.
 */

import { Injectable, Logger } from '@nestjs/common';

/**
 * Версия Google Ads API. Прежнее захардкоженное значение было `v18` —
 * отключённое Google 20 августа 2025 года, то есть все запросы этого
 * клиента гарантированно падали (сверка с документацией, сентябрь 2026).
 * Дефолт — актуальная на момент сверки v25; Google снимает версии
 * примерно через год, поэтому значение вынесено в переменную окружения,
 * чтобы следующий сдвиг не требовал правки кода и пересборки.
 */
const DEFAULT_API_VERSION = 'v25';

function apiVersion(): string {
  return process.env.GOOGLE_ADS_API_VERSION || DEFAULT_API_VERSION;
}

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

interface GoogleAdsConfig {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Цифры без дефисов — тот аккаунт, где реально крутятся кампании. */
  customerId: string;
  /** MCC-аккаунт, если рекламный кабинет управляется через менеджерский — необязателен. */
  loginCustomerId?: string;
}

export interface BlitzCampaignInput {
  listingId: string;
  title: string;
  thumbnailUrl: string | null;
  finalUrl: string;
  /** В валюте самого рекламного аккаунта, не payoutCurrency лота — см. доккомментарий класса, п.4. */
  dailyBudgetMicros: number;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Ширина и высота PNG или JPEG по заголовку файла, без декодирования
 * картинки целиком. Нужно ровно для одной проверки — что логотип
 * квадратный: Google принимает `LOGO` только 1:1, и неквадратный файл
 * отвергается с невнятной ошибкой уже после загрузки байтов. Формат,
 * который здесь не разобрался, возвращает null — тогда решает Google,
 * а не наш парсер.
 */
export function imageSize(
  buf: Buffer,
): { width: number; height: number } | null {
  // PNG: сигнатура + блок IHDR, ширина и высота лежат по фиксированным смещениям.
  if (
    buf.length >= 24 &&
    buf.readUInt32BE(0) === 0x89504e47 &&
    buf.readUInt32BE(4) === 0x0d0a1a0a
  ) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // JPEG: идём по маркерам сегментов до первого SOF, он и несёт размеры.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buf[offset + 1];
      // SOF0–SOF15 несут размеры, кроме DHT (0xC4), JPG (0xC8) и DAC (0xCC).
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return {
          height: buf.readUInt16BE(offset + 5),
          width: buf.readUInt16BE(offset + 7),
        };
      }
      const segmentLength = buf.readUInt16BE(offset + 2);
      // Длина сегмента меньше двух — файл испорчен (два байта занимает
      // само поле длины). Зациклиться разбор всё равно не может, шаг
      // всегда не меньше двух; но продолжать разбор испорченного файла
      // значит выдать случайные числа за размеры, поэтому выходим.
      if (segmentLength < 2) return null;
      offset += 2 + segmentLength;
    }
  }

  return null;
}

/** Лимиты Google на текстовые ассеты Performance Max. */
const HEADLINE_MAX_CHARS = 30;
const DESCRIPTION_MAX_CHARS = 90;
/**
 * Минимум заголовков, который Google принимает в asset group
 * (support.google.com/google-ads/answer/17091269). Ровно столько и
 * собираем: больше осмысленных вариантов из одного названия лота не
 * получить, а добивать группу шаблонными строками ради количества —
 * ухудшать объявление.
 */
const MIN_HEADLINES = 3;
/**
 * Справка Google требует, чтобы среди заголовков был хотя бы один не
 * длиннее 15 символов (иначе объявление считается неполным по ad
 * strength). Ни один заголовок, собранный из названия лота, этого не
 * гарантирует — поэтому есть отдельный короткий запасной набор.
 */
const SHORT_HEADLINE_MAX_CHARS = 15;
/** Лимит `LONG_HEADLINE`; минимум — один, обязателен. */
const LONG_HEADLINE_MAX_CHARS = 90;
/** Лимит `BUSINESS_NAME`; ровно один, обязателен при выключенных brand guidelines. */
const BUSINESS_NAME_MAX_CHARS = 25;
const BUSINESS_NAME = 'viral4creators';

const EXCLUSIVE_SUFFIX = ' — эксклюзив';

/**
 * Запасные заголовки — берутся по порядку, пока не наберётся минимум.
 * Нужны для случая, когда название лота само совпало с одним из
 * вариантов (например, лот буквально называется «Аукцион видео
 * viral4creators»).
 */
const FALLBACK_HEADLINES = [
  'Аукцион видео viral4creators',
  'Эксклюзивное UGC-видео',
  'Торги ограничены по времени',
  'Купить ролик на аукционе',
];

/** Короткие варианты (≤15 символов) — см. SHORT_HEADLINE_MAX_CHARS. */
const SHORT_HEADLINES = ['Аукцион видео', 'Эксклюзив UGC', 'Торги идут'];

/**
 * Ровно MIN_HEADLINES различных заголовков, каждый в пределах лимита
 * Google.
 *
 * Аудит-фикс: раньше список собирался как `new Set([truncate(title, 30),
 * truncate(title + ' — эксклюзив', 30), 'Аукцион видео viral4creators'])`
 * — и дедупликация схлопывала его до ДВУХ заголовков в двух разных
 * случаях, из которых первый на практике был не исключением, а нормой:
 *
 *  1. любое название длиннее 29 символов. Суффикс дописывался ДО
 *     обрезки, поэтому оба варианта обрезались до одних и тех же первых
 *     29 знаков плюс многоточие — то есть совпадали буквально. Для
 *     витрины видео названия такой длины обычны;
 *  2. название, совпавшее с третьим, шаблонным вариантом.
 *
 * Обе дыры закрыты: место под суффикс резервируется заранее (вариант 2
 * гарантированно отличается от варианта 1 — он оканчивается на
 * «эксклюзив»), а недостающее добирается из FALLBACK_HEADLINES.
 */
function buildHeadlines(title: string): string[] {
  const trimmed = title.trim();
  const candidates = [
    truncate(trimmed, HEADLINE_MAX_CHARS),
    trimmed
      ? `${truncate(trimmed, HEADLINE_MAX_CHARS - EXCLUSIVE_SUFFIX.length)}${EXCLUSIVE_SUFFIX}`
      : '',
    ...FALLBACK_HEADLINES,
  ];

  const headlines: string[] = [];
  for (const candidate of candidates) {
    const value = truncate(candidate.trim(), HEADLINE_MAX_CHARS);
    if (!value || headlines.includes(value)) continue;
    headlines.push(value);
    if (headlines.length === MIN_HEADLINES) break;
  }

  // Хотя бы один заголовок должен быть коротким. Заменяется ПОСЛЕДНИЙ:
  // первые два собраны из названия лота, а третий и так шаблонный —
  // объявление без названия лота бессмысленно.
  if (!headlines.some((h) => h.length <= SHORT_HEADLINE_MAX_CHARS)) {
    const short = SHORT_HEADLINES.find((s) => !headlines.includes(s));
    if (short) headlines[headlines.length - 1] = short;
  }
  return headlines;
}

/**
 * `LONG_HEADLINE` — обязательный для asset group тип ассета (минимум
 * один), которого этот клиент раньше не отправлял вовсе: asset group
 * без него неполон по требованиям Google Ads API.
 */
function buildLongHeadline(title: string): string {
  const trimmed = title.trim();
  return truncate(
    trimmed
      ? `Эксклюзивное видео «${trimmed}» — торги на viral4creators уже идут`
      : 'Эксклюзивное UGC-видео на аукционе viral4creators — торги уже идут',
    LONG_HEADLINE_MAX_CHARS,
  );
}

@Injectable()
export class GoogleAdsService {
  private readonly logger = new Logger(GoogleAdsService.name);
  private cachedToken: { value: string; expiresAt: number } | null = null;
  /** Логотип один на аккаунт — не заводим его копию на каждую кампанию. */
  private cachedLogoAsset: { url: string; resourceName: string } | null = null;

  private config(): GoogleAdsConfig | null {
    const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_ADS_REFRESH_TOKEN;
    const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID;
    if (
      !developerToken ||
      !clientId ||
      !clientSecret ||
      !refreshToken ||
      !customerId
    ) {
      return null;
    }
    return {
      developerToken,
      clientId,
      clientSecret,
      refreshToken,
      customerId,
      loginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || undefined,
    };
  }

  /** Публичный флаг — вызывающий код может залогировать/показать оператору, что интеграция не настроена, а не просто молча ничего не делать. */
  isConfigured(): boolean {
    return this.config() !== null;
  }

  private async accessToken(cfg: GoogleAdsConfig): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 60_000) {
      return this.cachedToken.value;
    }
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: cfg.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Google OAuth refresh не удался: ${res.status} ${text}`);
    }
    const data = JSON.parse(text) as {
      access_token: string;
      expires_in: number;
    };
    this.cachedToken = {
      value: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return data.access_token;
  }

  private async mutate(
    cfg: GoogleAdsConfig,
    token: string,
    resource: string,
    operations: Record<string, unknown>[],
  ): Promise<{ results: { resourceName: string }[] }> {
    const url = `https://googleads.googleapis.com/${apiVersion()}/customers/${cfg.customerId}/${resource}:mutate`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'developer-token': cfg.developerToken,
    };
    if (cfg.loginCustomerId) headers['login-customer-id'] = cfg.loginCustomerId;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ operations }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `Google Ads ${resource}:mutate не удался: ${res.status} ${text}`,
      );
    }
    return JSON.parse(text);
  }

  /**
   * Скачивает превью и кодирует в base64 — Google Ads принимает только
   * сами байты изображения (`imageAsset.data`), не ссылку на него.
   * Best-effort: сетевой сбой при скачивании превью не должен рушить
   * всю кампанию — просто останемся без изображения (см. вызывающий код).
   */
  private async fetchImageBuffer(url: string): Promise<Buffer | null> {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  /**
   * Ассет логотипа 1:1 — обязательный для asset group при выключенных
   * brand guidelines (см. доккомментарий класса, п.3). Логотип один на
   * весь аккаунт, а не на лот, поэтому берётся из `GOOGLE_ADS_LOGO_URL`
   * и кешируется в памяти процесса по этому URL: иначе каждая кампания
   * заводила бы в аккаунте ещё одну копию одной и той же картинки.
   *
   * Без переменной возвращает `null` — кампания всё равно создаётся
   * (реклама best-effort), но asset group остаётся неполной по меркам
   * API и, скорее всего, не включится на последнем шаге.
   */
  private async logoAssetResourceName(
    cfg: GoogleAdsConfig,
    token: string,
  ): Promise<string | null> {
    const url = process.env.GOOGLE_ADS_LOGO_URL;
    if (!url) {
      this.logger.warn(
        'GOOGLE_ADS_LOGO_URL не задан — asset group уйдёт без обязательного логотипа 1:1 (см. доккомментарий GoogleAdsService, п.3).',
      );
      return null;
    }
    if (this.cachedLogoAsset?.url === url)
      return this.cachedLogoAsset.resourceName;

    const buf = await this.fetchImageBuffer(url);
    if (!buf) {
      this.logger.warn(
        `Логотип по GOOGLE_ADS_LOGO_URL (${url}) не скачался — asset group без логотипа.`,
      );
      return null;
    }

    // Проверяем заранее: Google принимает LOGO только 1:1, и отправлять
    // заведомо негодный файл — зря потраченный вызов и невнятная ошибка
    // в логе вместо понятной. Формат, который не разобрался, отправляем
    // как есть — решать Google, а не нашему парсеру заголовков.
    const size = imageSize(buf);
    if (size && size.width !== size.height) {
      this.logger.warn(
        `Логотип по GOOGLE_ADS_LOGO_URL не квадратный (${size.width}×${size.height}) — Google требует 1:1, ассет не отправляется.`,
      );
      return null;
    }

    try {
      const res = await this.mutate(cfg, token, 'assets', [
        {
          create: {
            name: 'v4c-logo',
            imageAsset: { data: buf.toString('base64') },
          },
        },
      ]);
      const resourceName = res.results[0].resourceName;
      this.cachedLogoAsset = { url, resourceName };
      return resourceName;
    } catch (e) {
      this.logger.warn(
        `Загрузка логотипа в Google Ads не удалась: ${(e as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Создаёт Performance Max кампанию под один блиц-лот (§22, «Google
   * Ads для блиц-лотов»). Возвращает resource name кампании
   * (`customers/{id}/campaigns/{id}`) для записи в
   * `AuctionListing.googleAdsCampaignId`, либо `null`, если интеграция
   * не настроена или Google отказал на любом шаге — в обоих случаях
   * вызывающий код (`AuctionService`) должен просто продолжить без
   * рекламы, не блокируя сам аукцион (см. доккомментарий класса).
   */
  async createBlitzCampaign(input: BlitzCampaignInput): Promise<string | null> {
    const cfg = this.config();
    if (!cfg) {
      this.logger.debug(
        'Google Ads не настроен (нет учётных данных в env) — кампания для блиц-лота не создаётся.',
      );
      return null;
    }

    const token = await this.accessToken(cfg);

    // 1. Бюджет — фиксированный дневной лимит на окно блица (§22.1,
    //    «фиксированный небольшой лимит на 48 часов на лот»).
    const budgetRes = await this.mutate(cfg, token, 'campaignBudgets', [
      {
        create: {
          name: `v4c-blitz-${input.listingId}-budget`,
          amountMicros: String(
            Math.max(1, Math.round(input.dailyBudgetMicros)),
          ),
          deliveryMethod: 'STANDARD',
        },
      },
    ]);
    const budgetResourceName = budgetRes.results[0].resourceName;

    // 2. Кампания — создаётся PAUSED, включаем явно последним шагом,
    //    только после того как asset group собран (см. доккомментарий
    //    класса про то, почему включение может не пройти).
    const campaignRes = await this.mutate(cfg, token, 'campaigns', [
      {
        create: {
          name: `v4c-blitz-${input.listingId}`,
          advertisingChannelType: 'PERFORMANCE_MAX',
          status: 'PAUSED',
          campaignBudget: budgetResourceName,
          maximizeConversionValue: {},
          // Выключены осознанно: при включённых brand guidelines
          // BUSINESS_NAME/LOGO нужно привязывать на уровне КАМПАНИИ через
          // CampaignAsset, при выключенных — на уровне asset group, что
          // и делается ниже. С v21 Google включает их по умолчанию, так
          // что поле задаётся явно.
          brandGuidelinesEnabled: false,
          // `urlExpansionOptOut` убран: официальный пример PMax его не
          // задаёт, а лишнее поле — лишний повод для отказа при смене
          // версии API. Поведение по умолчанию (расширение URL включено)
          // это и есть то, что здесь было.
        },
      },
    ]);
    const campaignResourceName = campaignRes.results[0].resourceName;

    // Аудит-фикс: с этого момента кампания реально существует в
    // аккаунте — что бы ни случилось дальше (шаги 3–6 ниже), функция
    // обязана вернуть campaignResourceName, а не выбросить исключение и
    // потерять единственную ссылку на уже созданный ресурс. Раньше
    // ошибка на ЛЮБОМ следующем шаге (сборка asset group, привязка
    // текста/картинки, включение) пробрасывалась наверх необработанной —
    // AuctionService.activateGoogleAdsCampaignIfBlitz() ловил её в своём
    // try/catch, логировал и НЕ сохранял campaignResourceName в
    // googleAdsCampaignId, хотя бюджет+кампания к этому моменту уже
    // реально созданы в Google Ads — сирота без единой записи о себе ни
    // в БД, ни в логах с её resource name. Каждый шаг ниже теперь сам
    // ловит свою ошибку и продолжает — итоговый возврат
    // campaignResourceName происходит всегда.
    let assetGroupResourceName: string | null = null;
    try {
      // 3. Группа объявлений — одна на кампанию, финальный URL — карточка лота.
      const assetGroupRes = await this.mutate(cfg, token, 'assetGroups', [
        {
          create: {
            name: `v4c-blitz-${input.listingId}-ag`,
            campaign: campaignResourceName,
            finalUrls: [input.finalUrl],
            status: 'ENABLED',
          },
        },
      ]);
      assetGroupResourceName = assetGroupRes.results[0].resourceName;
    } catch (e) {
      this.logger.warn(
        `Кампания ${campaignResourceName} создана, но asset group — нет: ${(e as Error).message}`,
      );
    }

    if (assetGroupResourceName) {
      const agResourceName = assetGroupResourceName;

      // 4. Текстовые ассеты — минимум 3 заголовка / 2 описания (support.
      //    google.com/google-ads/answer/17091269) из названия лота.
      //    Аудит-фикс: привязка текста — ОТДЕЛЬНЫЙ mutate-вызов от
      //    привязки картинки ниже (было — один общий на всё, см. п.5).
      try {
        // Аудит-фикс: раньше типы полей восстанавливались нарезкой
        // ответа по индексам (`slice(0, headlines.length)`), и добавление
        // любого нового типа ассета означало ещё одну границу, которую
        // легко сдвинуть. Теперь тип едет рядом с текстом, а ответ Google
        // сопоставляется с запросом позиционно — один к одному, как и
        // раньше, но без арифметики по индексам.
        const textAssets: { text: string; fieldType: string }[] = [
          ...buildHeadlines(input.title).map((text) => ({
            text,
            fieldType: 'HEADLINE',
          })),
          { text: buildLongHeadline(input.title), fieldType: 'LONG_HEADLINE' },
          {
            text: truncate(
              `Эксклюзивное видео «${input.title}» — торги ограничены по времени.`,
              DESCRIPTION_MAX_CHARS,
            ),
            fieldType: 'DESCRIPTION',
          },
          {
            text: 'Виральный контент от проверенных исполнителей — ставьте сейчас.',
            fieldType: 'DESCRIPTION',
          },
          {
            text: truncate(BUSINESS_NAME, BUSINESS_NAME_MAX_CHARS),
            fieldType: 'BUSINESS_NAME',
          },
        ];

        const textAssetsRes = await this.mutate(
          cfg,
          token,
          'assets',
          textAssets.map(({ text }) => ({ create: { textAsset: { text } } })),
        );
        await this.mutate(
          cfg,
          token,
          'assetGroupAssets',
          textAssetsRes.results.map((r, i) => ({
            create: {
              assetGroup: agResourceName,
              asset: r.resourceName,
              fieldType: textAssets[i].fieldType,
            },
          })),
        );
      } catch (e) {
        this.logger.warn(
          `Текстовые ассеты для ${campaignResourceName} не удалось привязать: ${(e as Error).message}`,
        );
      }

      // 5. Изображение превью — единственное, что у нас есть на лот.
      //    ЧЕСТНО (см. доккомментарий класса, п.2): Google требует
      //    минимум 4 разных изображения на каждый из двух типов
      //    (horizontal 1.91:1 / square 1:1) — одного превью
      //    недостаточно, и видео-кадр почти наверняка не пройдёт точную
      //    валидацию соотношения сторон хотя бы для одного из двух.
      //    Аудит-фикс: раньше обе привязки (MARKETING_IMAGE и
      //    SQUARE_MARKETING_IMAGE) уходили в ОДНОМ атомарном
      //    assetGroupAssets:mutate вместе с текстовыми ассетами — без
      //    partialFailure отказ Google по одному-единственному
      //    несовпадению aspect ratio валил бы ВЕСЬ вызов целиком,
      //    включая уже валидные привязки заголовков/описаний выше.
      //    Теперь у каждого field type — свой независимый вызов.
      if (input.thumbnailUrl) {
        const imageBase64 =
          (await this.fetchImageBuffer(input.thumbnailUrl))?.toString(
            'base64',
          ) ?? null;
        if (imageBase64) {
          let imageAssetName: string | null = null;
          try {
            const imageAssetRes = await this.mutate(cfg, token, 'assets', [
              {
                create: {
                  name: `v4c-blitz-${input.listingId}-thumb`,
                  imageAsset: { data: imageBase64 },
                },
              },
            ]);
            imageAssetName = imageAssetRes.results[0].resourceName;
          } catch (e) {
            this.logger.warn(
              `Загрузка превью лота ${input.listingId} в Google Ads не удалась: ${(e as Error).message}`,
            );
          }
          if (imageAssetName) {
            const asset = imageAssetName;
            try {
              await this.mutate(cfg, token, 'assetGroupAssets', [
                {
                  create: {
                    assetGroup: agResourceName,
                    asset,
                    fieldType: 'MARKETING_IMAGE',
                  },
                },
              ]);
            } catch (e) {
              this.logger.warn(
                `MARKETING_IMAGE для ${campaignResourceName} не привязалась: ${(e as Error).message}`,
              );
            }
            try {
              await this.mutate(cfg, token, 'assetGroupAssets', [
                {
                  create: {
                    assetGroup: agResourceName,
                    asset,
                    fieldType: 'SQUARE_MARKETING_IMAGE',
                  },
                },
              ]);
            } catch (e) {
              this.logger.warn(
                `SQUARE_MARKETING_IMAGE для ${campaignResourceName} не привязалась (ожидаемо — см. доккомментарий класса, п.2): ${(e as Error).message}`,
              );
            }
          }
        } else {
          this.logger.warn(
            `Не удалось скачать превью лота ${input.listingId} для Google Ads — кампания без изображений.`,
          );
        }
      }

      // 5б. Логотип 1:1 — обязательный ассет asset group при выключенных
      //     brand guidelines. Отдельным вызовом, по тому же принципу,
      //     что и два формата превью выше: свой field type — свой
      //     независимый mutate, чтобы отказ по одному не уносил с собой
      //     остальные привязки.
      const logoAsset = await this.logoAssetResourceName(cfg, token);
      if (logoAsset) {
        try {
          await this.mutate(cfg, token, 'assetGroupAssets', [
            {
              create: {
                assetGroup: agResourceName,
                asset: logoAsset,
                fieldType: 'LOGO',
              },
            },
          ]);
        } catch (e) {
          this.logger.warn(
            `LOGO для ${campaignResourceName} не привязался: ${(e as Error).message}`,
          );
        }
      }
    }

    // 6. Включаем кампанию — последний шаг, после того как asset group
    //    полностью собран. Если Google откажет здесь (недостаточно
    //    ассетов/нет conversion goal — см. доккомментарий класса,
    //    пп.1–2), кампания остаётся PAUSED — безопасный дефолт, деньги
    //    не тратятся на заведомо неполную настройку.
    try {
      await this.mutate(cfg, token, 'campaigns', [
        {
          update: { resourceName: campaignResourceName, status: 'ENABLED' },
          updateMask: 'status',
        },
      ]);
    } catch (e) {
      this.logger.warn(
        `Кампания ${campaignResourceName} создана, но не включена автоматически (см. доккомментарий класса, пп.1–2): ${(e as Error).message}`,
      );
    }

    return campaignResourceName;
  }

  /**
   * Ставит кампанию на паузу — вызывается при уходе лота из ACTIVE
   * (WON/EXPIRED/REJECTED/WITHDRAWN, §22, «кампания сразу
   * приостанавливается»). Идемпотентно на стороне Google — повторная
   * пауза уже приостановленной кампании не ошибка.
   */
  async pauseCampaign(campaignResourceName: string): Promise<void> {
    const cfg = this.config();
    if (!cfg) return;
    const token = await this.accessToken(cfg);
    await this.mutate(cfg, token, 'campaigns', [
      {
        update: { resourceName: campaignResourceName, status: 'PAUSED' },
        updateMask: 'status',
      },
    ]);
  }
}
