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
 * ## Почему сегодня здесь один xAI
 *
 * Провайдеров, за которых платим, десять. Единого способа спросить
 * остаток у них нет: у части есть свой биллинговый API, у части —
 * только личный кабинет. Начат тот, который уже подводил (см.
 * `common/xai-balance.ts`); остальные честно отвечают «остаток не
 * отдаёт», а не молчат.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  ProviderBalance,
  XAI_MANAGEMENT_BASE,
  parseXaiBalance,
  previewBody,
  xaiBalancePath,
  xaiFailureReason,
} from '../../common/xai-balance';

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
  ELEVENLABS: 'остаток в символах, а не в деньгах — отдельная задача',
  RESEMBLE: 'публичного эндпоинта остатка нет',
  HEDRA: 'публичного эндпоинта остатка нет — кредиты видно в кабинете',
  SERPAPI: 'остаток в поисках, а не в деньгах — отдельная задача',
  YOUTUBE: 'квота в единицах Google API, не деньги',
  FFMPEG: 'сервис без публичного биллингового API',
};

@Injectable()
export class ProviderBalancesService {
  private readonly logger = new Logger(ProviderBalancesService.name);
  private cache: { at: number; items: ProviderBalance[] } | null = null;

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
    const items = [
      await this.xai(),
      ...Object.entries(NO_BALANCE_API).map(([provider, detail]) => ({
        provider,
        state: 'unsupported' as const,
        detail,
        checkedAt: new Date().toISOString(),
      })),
    ];
    this.cache = { at: Date.now(), items };
    return items;
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
      // Сырой ответ показывается ПОКА ЧТО всегда, а не только при
      // отказе: первый живой вызов дал `total.val = -1827` при остатке
      // $5.77 в консоли, и до выяснения, какое поле означает остаток
      // человека, экран обязан показывать то, что реально пришло.
      const rawBody = previewBody(body);
      if (parsed.amountMicroUsd === undefined) {
        return {
          provider: 'GROK',
          state: 'error',
          detail:
            'ответ получен, но остатка в нём нет — вероятно, аккаунт на постоплате: ' +
            'предоплаченных кредитов у него не бывает',
          raw: parsed.raw,
          rawBody,
          checkedAt,
        };
      }
      return {
        provider: 'GROK',
        state: 'ok',
        amountMicroUsd: parsed.amountMicroUsd,
        raw: parsed.raw,
        rawBody,
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
