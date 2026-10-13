/**
 * AI Publisher — порт часов (Р-PUB-Z2-21, интеграция Z-2b).
 *
 * `pubClock().now()` — текущее время модуля. По умолчанию — системные часы.
 * Подменяемые часы (`StandClock`) — ТОЛЬКО стенд сквозных маршрутов
 * (`scripts/publisher-e2e.sh`): ставит их `PublisherStandModule`, когда
 * `publisherStandClock()` (config/publisher-env.ts) разрешает — флаг
 * `PUBLISHER_STAND_CLOCK=true` И `NODE_ENV=development|test` И не Vercel; в
 * остальных окружениях запрос игнорируется с предупреждением.
 *
 * Подмена — на уровне ПРОЦЕССА (глобальный `Date` через Proxy: `new Date()`
 * без аргументов и `Date.now()` идут от часов стенда, остальное — как у
 * настоящего `Date`, экземпляры — настоящие `Date`). Почему не только порт:
 * время пишут не одни вызовы модуля — Prisma заполняет `@default(now())`
 * на стороне клиента (`createdAt`, `decidedAt`, `validFrom`, …), проверка
 * initData, задания кронов. Часы стенда, видимые только части кода, дали
 * бы данные с двумя временами. Время, которое ставит СЕРВЕР БД
 * (`DEFAULT now()` строк публичного приёма — роль `publisher_public` не
 * задаёт его по грантам), стенд подменяет своим триггером
 * (`test/publisher-e2e/stand-db-clock.sql`, только база стенда) по
 * настройке транзакции `pub.stand_now`, которую ставит `applyStandDbClock`;
 * в прод-базе такого триггера нет, а настройка не ставится.
 *
 * Часы стенда идут только вперёд (данные стенда не получают строк «из
 * прошлого» относительно уже записанных) и могут быть заморожены — чтобы
 * событие попало ровно в момент (сессия ровно в t42).
 */

/** Настоящий `Date` — захвачен при загрузке модуля, до любой подмены. */
const RealDate: DateConstructor = Date;

export interface PubClock {
  now(): Date;
  /** Часы стенда (подменяемые). */
  readonly stand: boolean;
}

class SystemClock implements PubClock {
  readonly stand = false;
  now(): Date {
    return new RealDate();
  }
}

export interface StandClockState {
  now: string;
  real: string;
  offsetMs: number;
  frozen: boolean;
}

export class StandClockError extends Error {}

export class StandClock implements PubClock {
  readonly stand = true;
  private offsetMs = 0;
  private frozenAt: number | null = null;

  nowMs(): number {
    return this.frozenAt ?? RealDate.now() + this.offsetMs;
  }

  now(): Date {
    return new RealDate(this.nowMs());
  }

  /**
   * Перевести часы: на момент `at` или вперёд на `advanceMs`; `freeze` —
   * остановить на нём (иначе часы идут от него). Назад — `StandClockError`.
   */
  set(o: { at?: Date; advanceMs?: number; freeze?: boolean }): void {
    const cur = this.nowMs();
    const target = o.at
      ? o.at.getTime()
      : cur + Math.max(0, Math.trunc(o.advanceMs ?? 0));
    if (!Number.isFinite(target))
      throw new StandClockError('момент не задан или не дата');
    if (target < cur)
      throw new StandClockError(
        `часы стенда идут только вперёд: ${new RealDate(target).toISOString()} < ${new RealDate(cur).toISOString()}`,
      );
    if (o.freeze) {
      this.frozenAt = target;
    } else {
      this.frozenAt = null;
      this.offsetMs = target - RealDate.now();
    }
  }

  state(): StandClockState {
    return {
      now: this.now().toISOString(),
      real: new RealDate().toISOString(),
      offsetMs:
        this.frozenAt === null ? this.offsetMs : this.frozenAt - RealDate.now(),
      frozen: this.frozenAt !== null,
    };
  }
}

let current: PubClock = new SystemClock();

/** Часы модуля. */
export function pubClock(): PubClock {
  return current;
}

/** Часы стенда, если стоят (иначе null). */
export function standClock(): StandClock | null {
  return current instanceof StandClock ? current : null;
}

/**
 * Поставить часы стенда в процесс (идемпотентно). Вызывает только
 * `PublisherStandModule` после проверки `publisherStandClock()`.
 */
export function installStandClock(): StandClock {
  const have = standClock();
  if (have) return have;
  const clock = new StandClock();
  const fake = new Proxy(RealDate, {
    construct(target, args: unknown[], newTarget) {
      return Reflect.construct(
        target,
        args.length === 0 ? [clock.nowMs()] : args,
        newTarget,
      ) as object;
    },
    apply() {
      // `Date()` как функция — строка текущего момента.
      return new RealDate(clock.nowMs()).toString();
    },
    get(target, prop, receiver) {
      if (prop === 'now') return () => clock.nowMs();
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  globalThis.Date = fake;
  current = clock;
  return clock;
}

/** Снять часы стенда (тесты). */
export function uninstallStandClock(): void {
  globalThis.Date = RealDate;
  current = new SystemClock();
}

/** Клиент транзакции с сырым SQL (структурно — как `RawTx` приёма). */
interface StandRawTx {
  $executeRaw(q: TemplateStringsArray, ...v: unknown[]): Promise<number>;
}

/**
 * Время СЕРВЕРА БД для строк публичного приёма на стенде: настройка
 * транзакции `pub.stand_now` (её читает триггер базы стенда). Без часов
 * стенда — ничего (прод).
 */
export async function applyStandDbClock(tx: StandRawTx): Promise<void> {
  const c = standClock();
  if (!c) return;
  await tx.$executeRaw`SELECT set_config('pub.stand_now', ${c.now().toISOString()}, true)`;
}
