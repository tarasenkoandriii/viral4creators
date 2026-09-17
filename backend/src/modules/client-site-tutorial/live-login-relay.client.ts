/**
 * Тонкий клиент сервиса `live-login-relay/` — §7.4.4 ТЗ
 * (doc/CLIENT-SITE-TUTORIAL-SPEC.md) и §7/§15 контракта
 * (doc/LIVE-LOGIN-RELAY-SPEC.md), этап 114.
 *
 * ## Зачем вообще живая сессия
 *
 * Обычная форма «логин + пароль + войти» закрывается двумя `fill` и
 * одним `click` без всякого «живого» браузера. Но капчу, одноразовый код
 * и вход через чужой SSO нельзя описать заранее детерминированным
 * шагом: их содержимое узнаётся только в моменте и требует живого
 * человека. Реле — не «более дорогой логин», а единственный способ
 * пройти ровно эти три случая (§7.4.0).
 *
 * ## Весь этот файл написан по §15 контракта — списку граблей
 *
 * Сервис реле готов, покрыт тестами и задеплоен, но до этого этапа его
 * не вызывал НИКТО: контракт ни разу не исполнялся целиком. Аудит
 * (§15) заранее перечислил места, где буквальное чтение основного ТЗ
 * разошлось бы с фактическим поведением реле. Каждое из них закрыто
 * здесь явно, и ссылка на пункт стоит рядом с кодом — чтобы правка «а
 * давайте добавим ретрай» не прошла мимо причины.
 */

import { Injectable, Logger } from '@nestjs/common';

export interface RelayCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  expires: number;
}

export interface RelaySession {
  sessionId: string;
  streamToken: string;
  /** Полный `wss://`-адрес канала — реле отдаёт только путь, свой
   * публичный хост оно не знает (§15.3). */
  relayWsUrl: string;
}

export interface RelayResult {
  cookies: RelayCookie[];
  finalUrl: string;
}

/** Реле недоступно/перегружено/браузер не поднялся — «сейчас не
 * получилось», а не ошибка запроса. */
export class RelayUnavailableError extends Error {}
/** Сессия уже закрыта (таймаут, отмена, шатдаун) — 410. Повторять
 * бессмысленно (§15.1). */
export class RelaySessionGoneError extends Error {}
/** Реле не настроено переменными окружения — фича мягко выключена. */
export class RelayNotConfiguredError extends Error {}

/**
 * Больше, чем `SESSION_NAV_TIMEOUT_MS` реле (20с): `POST /sessions` ждёт
 * `page.goto()` на ЧУЖОМ сайте. Типовые 15 секунд этого проекта
 * (`youtube-search.service.ts`) означали бы, что backend сдался раньше
 * ответа, показал ошибку — а реле довело сессию до конца и держало
 * живой браузер и место под своим потолком все три минуты (§15.4).
 */
const START_TIMEOUT_MS = 35_000;
/** Остальные вызовы дешёвые: снять куки и закрыть браузер. */
const SHORT_TIMEOUT_MS = 15_000;

@Injectable()
export class LiveLoginRelayClient {
  private readonly logger = new Logger(LiveLoginRelayClient.name);

  /** §15.8: у мягкой деградации обязан быть ЯВНЫЙ канал. Этот признак
   * уезжает в ответ `GET /site-tutorial`, чтобы фронтенд прятал кнопку
   * живого входа осознанно, а не догадывался по тексту ошибки. */
  configured(): boolean {
    return !!this.baseUrl() && !!this.secret();
  }

  private baseUrl(): string | undefined {
    return (
      process.env.LIVE_LOGIN_RELAY_URL?.trim().replace(/\/+$/, '') || undefined
    );
  }

  private secret(): string | undefined {
    return process.env.LIVE_LOGIN_RELAY_SECRET?.trim() || undefined;
  }

  /**
   * §15.3: реле отдаёт только `wsPath`, публичного хоста своего не
   * знает. Собираем сами — заменой схемы у `LIVE_LOGIN_RELAY_URL`, что
   * делает эту переменную ОБЯЗАННОЙ быть публичным адресом реле.
   * `LIVE_LOGIN_RELAY_WS_URL` — отдельная переменная на случай, когда
   * это не так (внутренний адрес для backend, публичный для браузера):
   * такая развязка типична, и обнаружить её нехватку на проде дороже,
   * чем поддержать сразу.
   */
  private wsBase(): string {
    const explicit = process.env.LIVE_LOGIN_RELAY_WS_URL?.trim();
    if (explicit) return explicit.replace(/\/+$/, '');
    const http = this.baseUrl() ?? '';
    return http.replace(/^http/, 'ws');
  }

  async createSession(input: {
    startUrl: string;
    allowedOrigin: string;
  }): Promise<RelaySession> {
    // §15.5: метод НЕ идемпотентен — каждый вызов поднимает новый
    // браузер и занимает место под общим потолком реле. `502` здесь
    // значит «браузер не поднялся», и повтор просто поднимет ещё один.
    // Общий `fetchWithRetry` проекта для него не годится, и ретрая
    // здесь нет ни одного.
    //
    // Про §15.4 отдельно: пункт требует слать `DELETE` при сдаче по
    // таймауту — но послать его НЕЧЕМ, `sessionId` приезжает ровно тем
    // ответом, которого мы не дождались. Это не недоработка, а предел
    // контракта; отсюда и единственная доступная защита — держать наш
    // таймаут заведомо больше навигационного таймаута реле, чтобы в эту
    // дыру не попадать вовсе. Брошенную сессию подберут собственные
    // таймауты реле (стена — три минуты).
    const body = await this.call<{
      sessionId: string;
      streamToken: string;
      wsPath: string;
    }>('POST', '/sessions', {
      timeoutMs: START_TIMEOUT_MS,
      body: input,
    });
    return {
      sessionId: body.sessionId,
      streamToken: body.streamToken,
      relayWsUrl: `${this.wsBase()}${body.wsPath}`,
    };
  }

  /**
   * Идемпотентен в окне кэша реле — единственный вызов, который
   * повторять безопасно (§15.5). Мы этим не пользуемся: повтор нужен
   * фронтенду при обрыве, а не нам.
   */
  async fetchResult(sessionId: string): Promise<RelayResult> {
    return this.call<RelayResult>(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}/result`,
      { timeoutMs: SHORT_TIMEOUT_MS },
    );
  }

  /**
   * Best-effort ранняя отмена. Зовётся там, где сессия нам больше не
   * нужна, но реле об этом ещё не знает: отказ по итогу проверки
   * `finalUrl` и любая ошибка после успешного старта. Не обязательна для
   * корректности — таймауты реле дадут тот же результат чуть позже, —
   * но освобождает место под потолком раньше.
   */
  async cancelQuietly(sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;
    try {
      await this.call<unknown>(
        'DELETE',
        `/sessions/${encodeURIComponent(sessionId)}`,
        { timeoutMs: SHORT_TIMEOUT_MS },
      );
    } catch (err) {
      this.logger.warn(
        `не удалось отменить сессию реле: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: {
      timeoutMs: number;
      body?: unknown;
    },
  ): Promise<T> {
    const base = this.baseUrl();
    const secret = this.secret();
    if (!base || !secret) {
      throw new RelayNotConfiguredError(
        'живой вход не настроен на этом стенде (LIVE_LOGIN_RELAY_URL/LIVE_LOGIN_RELAY_SECRET)',
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          'X-Relay-Secret': secret,
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
      });
    } catch (err) {
      throw new RelayUnavailableError(
        `реле живого входа не ответило: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 204) return undefined as T;

    if (!res.ok) {
      // §15.6: ни тело ответа, ни тело запроса в лог не идут — через
      // этот же канал летят пароли и куки. В лог — только метод, путь и
      // код; текст ошибки реле отдаётся пользователю по цепочке, но не
      // пишется в журнал.
      this.logger.warn(`реле ответило ${res.status} на ${method} ${path}`);
      const text = await safeText(res);
      throw this.errorFor(res.status, text);
    }

    return (await res.json()) as T;
  }

  private errorFor(status: number, text: string): Error {
    if (status === 410) {
      // §15.1: 410 не описан ни в одном документе, а встретится первым.
      // Это «сессия истекла, начните заново», БЕЗ ретрая.
      return new RelaySessionGoneError(
        'сессия живого входа истекла — начните вход заново',
      );
    }
    if (status === 404) {
      return new RelaySessionGoneError(
        'сессия живого входа не найдена — возможно, она уже закрыта',
      );
    }
    if (status === 503) {
      return new RelayUnavailableError(
        'сервис живого входа сейчас перегружен — попробуйте через минуту',
      );
    }
    if (status === 502) {
      return new RelayUnavailableError(
        `не удалось открыть страницу сайта заказчика в живой сессии: ${text || 'браузер не запустился'}`,
      );
    }
    if (status === 401) {
      return new RelayUnavailableError(
        'живой вход настроен неверно: реле не принимает наш секрет',
      );
    }
    return new RelayUnavailableError(
      `реле живого входа ответило ошибкой ${status}${text ? `: ${text}` : ''}`,
    );
  }
}

/** Тело ошибки читаем best-effort: у него нет гарантий формата, и
 * падение здесь подменило бы настоящую причину. */
async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}
