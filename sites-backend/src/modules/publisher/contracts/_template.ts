/**
 * AI Publisher — шаблон контракта маршрутов пакета (P-A1, проектный
 * документ §11.1, §16.0, аудит P2-21).
 *
 * Каждый пакет этапа 1 пишет `contracts/<пакет>-api.ts` по этому образцу в
 * первые 1–2 дня; координатор сверяет с §11.3 и замораживает. assist
 * (P-G1/P-G2) и publisher-site (P-F) сверяют свои декодеры с типами
 * (`assist/scripts/publisher-*-api.test.ts` читают исходник).
 *
 * Правила:
 *  1. Один `RouteSpec` на маршрут: метод, путь от `/publisher` (кабинет)
 *     или `/public/publisher/v1` (публичный), действие матрицы §4.2
 *     (`PubAction`, для публичных — `null`), признак мутации.
 *  2. Мутация: тело расширяет `MutationBody` (`opKey`), голова —
 *     `RevisionedBody` (`expectedRevision`). Чтения `opKey` не принимают.
 *  3. Суммы — `MinorJson` (строка цифр), даты — ISO-строки, неизвестное —
 *     `null` рядом со статусом (не ноль), метрики — `Computable<T>`.
 *  4. Списки — `ListQuery` → `ListPage<T>`; у списков есть `?format=csv`.
 *  5. Ошибки — только коды `contracts/errors.ts`; новые — запросом §17.4.
 *  6. В ответах мутаций нет ключей ПД (`contact, name, task, *Enc`): их
 *     отвергает `runOperation` и триггер ключа идемпотентности; раскрытие —
 *     отдельный `POST` без ключа идемпотентности и хранения ответа
 *     (`mutation: false`; `GET` с записью в журнал барьеры CSRF веб-кабинета
 *     не защищают — Р-PUB-Z2-25).
 *  7. Тест пакета сверяет список `ROUTES` с перечислителем маршрутов
 *     (`core/route-enumerator.ts`): метод, путь, действие.
 *
 * Пример заполнения — `contracts/core-api.ts` (маршруты P-A1).
 */
import type { PubAction } from '../core/roles';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Описание маршрута; `Req`/`Res` — фантомные типы тела и ответа. */
export interface RouteSpec<Req, Res> {
  method: HttpMethod;
  path: string;
  /** Действие матрицы (кабинет) или null (публичный маршрут). */
  action: PubAction | readonly PubAction[] | null;
  mutation: boolean;
  /** HTTP-статус успешного ответа (201 — создание). */
  status: number;
  readonly __req?: Req;
  readonly __res?: Res;
}

export function route<Req, Res>(
  spec: Omit<RouteSpec<Req, Res>, '__req' | '__res'>,
): RouteSpec<Req, Res> {
  return spec;
}

/** Тип тела маршрута. */
export type RequestOf<R> = R extends RouteSpec<infer Q, unknown> ? Q : never;
/** Тип ответа маршрута (поле `data` конверта). */
export type ResponseOf<R> = R extends RouteSpec<unknown, infer S> ? S : never;
