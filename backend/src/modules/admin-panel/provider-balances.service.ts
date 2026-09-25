/**
 * ProviderBalancesService — «сколько у нас ОСТАЛОСЬ» (TODO §III п.36).
 *
 * Отчёт о расходах (`/admin/costs`) отвечает на другой вопрос —
 * «сколько ПОТРАЧЕНО». Кончившийся баланс у одного провайдера это не
 * строка в отчёте, а вставший продукт, и узнаётся он сегодня по ошибке
 * генерации у живого пользователя.
 *
 * ## Три состояния, а не два
 *
 * «Остаток неизвестен» — бесполезный ответ, потому что в нём слиты три
 * разные ситуации: провайдер остатка не отдаёт вовсе; отдаёт, но у нас
 * не заданы ключи; отдаёт и ключи есть, но запрос не прошёл. Первое не
 * требует действий никогда, второе — разовой настройки, третье —
 * разбирательства прямо сейчас. Поэтому `BalanceState` различает их, а
 * экран показывает `detail` — что именно делать.
 *
 * ## Почему спрошены не все десять
 *
 * Провайдеров, за которых платим, десять. Единого способа спросить
 * остаток у них нет: у части есть свой биллинговый API, у части —
 * только личный кабинет. Первым сделан тот, который уже подводил (см.
 * `common/xai-balance.ts`), затем — двое, у кого остаток есть, но НЕ В
 * ДЕНЬГАХ: ElevenLabs (символы) и SerpApi (поиски), этап 142.
 * Остальные честно отвечают «остаток не отдаёт», а не молчат.
 *
 * ## Почему единицы не переводятся в доллары
 *
 * Соблазн большой: одна колонка, всё складывается. Но цена символа
 * зависит от тарифа и меняется без нашего участия, и пересчитанная
 * нами сумма разошлась бы со счётом провайдера — без всякого способа
 * это заметить. Экран показывает то, что провайдер сказал, в его же
 * единицах.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  balanceWatch,
  concernFingerprint,
  thresholdsFromEnv,
} from '../../common/balance-alerts';
import { TelegramNotifyService } from '../notify/telegram-notify.service';
import {
  BalanceUnits,
  ELEVENLABS_SUBSCRIPTION_URL,
  SERPAPI_ACCOUNT_URL,
  parseElevenLabsBalance,
  parseSerpApiBalance,
  redactKey,
} from '../../common/unit-balance';
import {
  ProviderBalance,
  XAI_MANAGEMENT_BASE,
  XaiChangesSummary,
  parseXaiBalance,
  previewBody,
  xaiBalancePath,
  xaiFailureReason,
} from '../../common/xai-balance';

/**
 * Подпись под суммой.
 *
 * Разбивка по журналу полезна («пополнено столько, списано столько»),
 * но ровно до тех пор, пока журнал полон. Провайдер отдаёт его с
 * ограничением, и молча показанная неполная разбивка — это цифры,
 * которые не сходятся с остатком, без объяснения почему.
 */
export function balanceNote(changes?: XaiChangesSummary): string | undefined {
  if (!changes) return undefined;
  if (!changes.matchesTotal) {
    return `журнал пришёл неполным (${changes.entries} записей) — разбивка по нему справочная, остаток берётся из total`;
  }
  const money = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;
  return `пополнено ${money(changes.purchasedMicroUsd)}, списано ${money(changes.spentMicroUsd)} за ${changes.entries} записей`;
}

/** Сколько держать ответ, прежде чем спрашивать снова. */
export const BALANCE_CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Провайдеры, у которых остаток спросить нечем, — и почему.
 *
 * Список явный, а не «всё остальное»: молчание экрана про провайдера,
 * которого просто забыли добавить, ничем не отличается от молчания про
 * провайдера без API, а разница существенная.
 */
const NO_BALANCE_API: Record<string, string> = {
  GEMINI: 'Google Cloud не отдаёт остаток по ключу — смотрите в Cloud Billing',
  OPENAI: 'публичного эндпоинта остатка нет — смотрите в личном кабинете',
  VEO: 'тарифицируется через Google Cloud, отдельного остатка нет',
  RESEMBLE: 'публичного эндпоинта остатка нет',
  HEDRA: 'публичного эндпоинта остатка нет — кредиты видно в кабинете',
  YOUTUBE: 'квота в единицах Google API, не деньги',
  FFMPEG: 'сервис без публичного биллингового API',
};

/**
 * Где посмотреть остаток своими глазами.
 *
 * Добавлено по запросу владельца: у GROK наше число расходится с
 * консолью, и пока это не разобрано, экран обязан давать дорогу к
 * первоисточнику. Список общий, а не только для xAI: «остаток спросить
 * нечем» — тем более повод дать ссылку, а не одну фразу «смотрите в
 * кабинете» без адреса.
 *
 * Только корневые адреса консолей: глубокие ссылки на страницы биллинга
 * у всех перечисленных меняются чаще, чем этот файл, и протухшая ссылка
 * хуже отсутствующей.
 */
const DASHBOARD_URL: Record<string, string> = {
  GROK: 'https://console.x.ai/',
  GEMINI: 'https://console.cloud.google.com/billing',
  VEO: 'https://console.cloud.google.com/billing',
  OPENAI: 'https://platform.openai.com/usage',
  ELEVENLABS: 'https://elevenlabs.io/app/usage',
  RESEMBLE: 'https://app.resemble.ai/',
  HEDRA: 'https://www.hedra.com/',
  SERPAPI: 'https://serpapi.com/dashboard',
  YOUTUBE: 'https://console.cloud.google.com/apis/dashboard',
};

@Injectable()
export class ProviderBalancesService {
  private readonly logger = new Logger(ProviderBalancesService.name);
  private cache: { at: number; items: ProviderBalance[] } | null = null;

  constructor(private readonly notify: TelegramNotifyService) {}

  /**
   * Сторож остатков (этап 143): раз в сутки посмотреть и, если есть о
   * чём, написать в канал ошибок.
   *
   * Кеш обходится намеренно. Он существует ради чужих ограничений
   * частоты при живом человеке у экрана; сторож ходит раз в сутки, и
   * ответить ему пятиминутной стариной значило бы сторожить не то, что
   * есть сейчас.
   *
   * Сообщение на КАЖДЫЙ повод отдельно, а не одно общее: у каждого свой
   * отпечаток, и молчание про один провайдер не прячет крик про
   * другого. Переменных частей в отпечатке нет — иначе дедупликация не
   * срабатывает вовсе (правило `TelegramNotifyService.alert`).
   */
  async watch(): Promise<{
    watched: number;
    low: number;
    unreadable: number;
    notified: number;
  }> {
    const items = await this.list(true);
    const { watched, concerns } = balanceWatch(items, thresholdsFromEnv());
    // Сообщения ПАРАЛЛЕЛЬНО (аудит этапа 143): у отправки в Telegram
    // свой таймаут в пять секунд, и три подряд ложились поверх десяти
    // секунд на сами остатки — двадцать пять в худшем случае, снова
    // мимо таймаута функции. Отпечатки у поводов разные, так что
    // записи дедупликации друг с другом не спорят.
    const sent = await Promise.all(
      concerns.map((concern) =>
        this.notify.alert(concernFingerprint(concern), concern.text),
      ),
    );
    return {
      watched,
      low: concerns.filter((c) => c.kind === 'low').length,
      unreadable: concerns.filter((c) => c.kind === 'unreadable').length,
      notified: sent.filter(Boolean).length,
    };
  }

  /**
   * `force` обходит кеш — кнопка «обновить» на экране. Кеш существует
   * не ради нашей скорости, а ради чужих ограничений частоты: у xAI
   * есть 429, и экран, который спрашивает на каждый рендер, доводит до
   * него сам.
   */
  async list(force = false): Promise<ProviderBalance[]> {
    if (
      !force &&
      this.cache &&
      Date.now() - this.cache.at < BALANCE_CACHE_TTL_MS
    ) {
      return this.cache.items;
    }
    // Ссылка приклеивается ЗДЕСЬ, а не внутри `xai()`: та логика
    // считает остаток и трогать её незачем — адрес консоли от неё не
    // зависит и одинаков во всех четырёх её исходах.
    // ПАРАЛЛЕЛЬНО, а не по очереди (аудит этапа 142). Провайдеры
    // независимы и живут на разных хостах, а таймаут у каждого свой —
    // десять секунд. По очереди худший случай складывается в тридцать,
    // и запрос перестаёт укладываться в таймаут функции: у продукта
    // это уже было на сборке дорожек (находка аудита этапа 139), а
    // уйти в фон у serverless нельзя. Ни один из трёх наружу не
    // бросает, так что `Promise.all` здесь ничего не теряет.
    const asked = await Promise.all([
      this.xai(),
      this.elevenLabs(),
      this.serpApi(),
    ]);
    const items = [
      ...asked,
      ...Object.entries(NO_BALANCE_API).map(([provider, detail]) => ({
        provider,
        state: 'unsupported' as const,
        detail,
        checkedAt: new Date().toISOString(),
      })),
    ].map((item) => ({
      ...item,
      dashboardUrl: DASHBOARD_URL[item.provider],
    }));
    this.cache = { at: Date.now(), items };
    return items;
  }

  /**
   * Остаток символов ElevenLabs. Ключ тот же, которым ходит синтез
   * (`VOICE_API_KEY`), — отдельного биллингового у них нет.
   */
  private async elevenLabs(): Promise<ProviderBalance> {
    return this.units({
      provider: 'ELEVENLABS',
      key: process.env.VOICE_API_KEY?.trim(),
      envName: 'VOICE_API_KEY',
      url: ELEVENLABS_SUBSCRIPTION_URL,
      init: (key) => ({ headers: { 'xi-api-key': key } }),
      parse: parseElevenLabsBalance,
      unparsed:
        'ответ получен, но в нём нет ни `character_count`, ни `character_limit` — ' +
        'из чего считать остаток, неизвестно',
    });
  }

  /**
   * Остаток поисков SerpApi. Сам запрос счёта бесплатный и в месячную
   * квоту не попадает (их документация), так что кеш здесь — вежливость
   * к чужим ограничениям частоты, а не экономия.
   */
  private async serpApi(): Promise<ProviderBalance> {
    const key = process.env.SERPAPI_API_KEY?.trim();
    return this.units({
      provider: 'SERPAPI',
      key,
      envName: 'SERPAPI_API_KEY',
      // Ключ строкой запроса — заголовка их API не принимает. Адрес
      // собирается здесь и НИКУДА не попадает: ни в лог, ни в `detail`
      // (см. шапку `common/unit-balance.ts`).
      url: `${SERPAPI_ACCOUNT_URL}?api_key=${encodeURIComponent(key ?? '')}`,
      init: () => ({}),
      parse: parseSerpApiBalance,
      unparsed:
        'ответ получен, но остатка поисков в нём нет — вероятно, ключ от другого аккаунта',
    });
  }

  /**
   * Общая половина обоих: спросить, разобрать, назвать причину. Разные
   * у них только адрес, способ передать ключ и разбор — всё остальное
   * (нет ключа / не ответили / ответили не тем) одинаково, а написанное
   * дважды расходится на первой же правке.
   */
  private async units(input: {
    provider: string;
    key: string | undefined;
    envName: string;
    url: string;
    init: (key: string) => RequestInit;
    parse: (body: unknown) => BalanceUnits | null;
    unparsed: string;
  }): Promise<ProviderBalance> {
    const checkedAt = new Date().toISOString();
    if (!input.key) {
      return {
        provider: input.provider,
        state: 'not-configured',
        detail: `не задан ${input.envName} — тот же ключ, которым продукт ходит к этому провайдеру`,
        checkedAt,
      };
    }
    try {
      const res = await fetch(input.url, {
        ...input.init(input.key),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        return {
          provider: input.provider,
          state: 'error',
          // Ни адреса, ни тела: у SerpApi в адресе ключ, а тело ошибки
          // у обоих провайдеров может его повторить.
          detail: `провайдер ответил ${res.status}`,
          checkedAt,
        };
      }
      const units = input.parse(await res.json());
      if (!units) {
        return {
          provider: input.provider,
          state: 'error',
          detail: input.unparsed,
          checkedAt,
        };
      }
      return { provider: input.provider, state: 'ok', units, checkedAt };
    } catch (e) {
      // Ключ вычищается ДО журнала и до `detail`: у SerpApi он стоит в
      // адресе запроса, а часть отказов `fetch` называет адрес в тексте
      // (аудит этапа 142).
      const message = redactKey(
        e instanceof Error ? e.message : String(e),
        input.key,
      );
      this.logger.warn(`остаток ${input.provider} не прочитан: ${message}`);
      return {
        provider: input.provider,
        state: 'error',
        detail: `запрос не прошёл: ${message}`,
        checkedAt,
      };
    }
  }

  private async xai(): Promise<ProviderBalance> {
    const checkedAt = new Date().toISOString();
    const key = process.env.XAI_MANAGEMENT_KEY?.trim();
    const teamId = process.env.XAI_TEAM_ID?.trim();
    if (!key || !teamId) {
      // Не «ошибка», а «не настроено»: действий это требует разовых, и
      // называть их надо прямо здесь, иначе настраивать будут наугад.
      const missing = [
        !key ? 'XAI_MANAGEMENT_KEY' : null,
        !teamId ? 'XAI_TEAM_ID' : null,
      ].filter(Boolean);
      return {
        provider: 'GROK',
        state: 'not-configured',
        detail:
          `не задано: ${missing.join(', ')}. Management-ключ и team_id берутся ` +
          'в консоли xAI (Settings → Management keys); ключ генерации сюда не подходит',
        checkedAt,
      };
    }

    const url = `${XAI_MANAGEMENT_BASE}${xaiBalancePath(teamId)}`;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        return {
          provider: 'GROK',
          state: 'error',
          // Адрес в сообщении намеренно: половина прошлых неудач с этим
          // API — обращение не на тот хост.
          detail: `${xaiFailureReason(res.status)} (запрос: GET ${XAI_MANAGEMENT_BASE}${xaiBalancePath('…')})`,
          checkedAt,
        };
      }
      const body: unknown = await res.json();
      const parsed = parseXaiBalance(body);
      if (parsed.amountMicroUsd === undefined) {
        // Сырой ответ прикладывается только здесь: разобрать не вышло,
        // и без тела следующий заход начнётся с того же места, что и
        // прошлый, — с догадок.
        return {
          provider: 'GROK',
          state: 'error',
          detail:
            'ответ получен, но остатка в нём нет — вероятно, аккаунт на постоплате: ' +
            'предоплаченных кредитов у него не бывает',
          raw: parsed.raw,
          rawBody: previewBody(body),
          checkedAt,
        };
      }
      return {
        provider: 'GROK',
        state: 'ok',
        amountMicroUsd: parsed.amountMicroUsd,
        raw: parsed.raw,
        changes: parsed.changes,
        detail: balanceNote(parsed.changes),
        checkedAt,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(`остаток xAI не прочитан: ${message}`);
      return {
        provider: 'GROK',
        state: 'error',
        detail: `запрос не прошёл: ${message}`,
        checkedAt,
      };
    }
  }
}
