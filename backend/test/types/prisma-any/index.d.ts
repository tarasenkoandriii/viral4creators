/**
 * Заглушка `@prisma/client` для ПЕСОЧНОЙ проверки типов
 * (`tsconfig.typecheck.json` → `paths`). В CI и прод-сборке её нет:
 * там `prisma generate` отрабатывает и типы настоящие.
 *
 * ## Зачем файл, если рядом уже лежит `declare module '@prisma/client'`
 *
 * Сокращённое объявление работает, только пока пакета нет физически. А
 * он в песочнице стоит (просто без сгенерированного `.prisma/client`),
 * и разрешение модулей находит его настоящий `index.d.ts` раньше
 * ambient-объявления. Тот ссылается на несгенерированный клиент —
 * проверка тонет в сотне ошибок «namespace has no exported member», и
 * настоящую ошибку в спеке среди них не видно. `paths` уводит импорт
 * сюда, и шум пропадает.
 *
 * ## Почему список имён, а не `any` целиком
 *
 * `any` целиком в TypeScript не выражается: `export = any` закрывает
 * позиции значений, но не типов, и `Prisma.TransactionClient` как тип
 * всё равно не разрешится. Поэтому перечислены ровно те имена, которые
 * импортирует код. Это не недостаток: новый импорт даёт ЧЕСТНУЮ ошибку
 * «нет такого экспорта» — видно сразу и правится одной строкой здесь.
 *
 * ## Что остаётся шуметь — и почему это не лечится здесь
 *
 * Строки из `any`-клиента приходят как `any`, и каждый их разбор
 * (`rows.map((r) => …)`) даёт TS7006 «параметр неявно any» — около
 * восьмидесяти штук, которых в настоящей сборке нет и быть не может:
 * там типы строк выведены. Выключить `noImplicitAny` в песочном
 * конфиге нельзя: без него перестают работать «растущие» массивы
 * (`const xs = []` становится `never[]`), и вместо восьмидесяти
 * честных артефактов получаем пять ЛОЖНЫХ ошибок в рабочем коде — а
 * это хуже, потому что они выглядят как настоящие.
 *
 * Поэтому смотреть в выводе нужно на всё, КРОМЕ TS7006/TS7031:
 * `npm run typecheck:sandbox | grep -v 'TS7006\|TS7031'`. Раньше
 * шумели ещё и три десятка «namespace has no exported member» — вот их
 * эта заглушка и убрала.
 *
 * ## Чего заглушка НЕ ловит — список пополняется кровью
 *
 * Пока клиент здесь `any`, любые ошибки в ФОРМЕ вызовов Prisma
 * проходят молча и ждут прод-сборки. Два случая уже случились (деплой
 * волны C), и оба повторяемы:
 *
 *  1. **`$transaction([...])` с `push`.** Тип массива выводится по
 *     ПЕРВОМУ элементу, и дописанная операция на другой модели не
 *     проходит. Массив-литерал из разных моделей — можно (выводится
 *     объединение), `push` — нельзя. Если операций больше одной и они
 *     по разным моделям, берите интерактивную форму
 *     `$transaction(async (tx) => …)`.
 *  2. **`groupBy` с типом СЛЕВА.** `const x: Array<…> = await
 *     prisma.model.groupBy({…})` выбирает не ту перегрузку и требует
 *     от аргумента быть массивом результата. Пишите приведение справа:
 *     `(await prisma.model.groupBy({…})) as unknown as Array<…>`.
 *
 * Общее правило для нового кода: тип результата запроса Prisma
 * задавайте приведением СПРАВА, а не аннотацией слева. Аннотация
 * участвует в выборе перегрузки, приведение — нет.
 *
 * ## Чем это безопаснее прежнего `declare module`
 *
 * Прежнее объявление было ГЛОБАЛЬНЫМ: стоило любому конфигу подобрать
 * файл маской — и настоящий клиент становился `any` везде, чем дважды
 * срывало боевой деплой (см. `src/common/tsconfig-split.spec.ts`).
 * Здесь объявления глобального нет вовсе: файл — обычный модуль, и
 * достать его можно только через `paths` песочного конфига. Утечь
 * некуда по построению.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export declare class PrismaClient {
  constructor(...args: any[]);
  /** Дженерики нужны явно: вызов значения типа `any` с параметрами
   * типа — ошибка TS2347, а `$queryRawUnsafe<Row[]>(…)` в коде есть. */
  $queryRaw<T = any>(...args: any[]): Promise<T>;
  $queryRawUnsafe<T = any>(...args: any[]): Promise<T>;
  $executeRaw<T = any>(...args: any[]): Promise<T>;
  $executeRawUnsafe<T = any>(...args: any[]): Promise<T>;
  $transaction<T = any>(...args: any[]): Promise<T>;
  [key: string]: any;
}

/** Модели, которые код импортирует как типы строк. */
export type Session = any;

/** Перечисления: они нужны и как значения, и как типы. */
export declare const AbTestVariantStatus: any;
export type AbTestVariantStatus = any;
export declare const BlogPostStatus: any;
export type BlogPostStatus = any;
export declare const BlogTranslationStatus: any;
export type BlogTranslationStatus = any;
export declare const CatalogBatchItemStatus: any;
export type CatalogBatchItemStatus = any;
export declare const ProductFeedImportRunStatus: any;
export type ProductFeedImportRunStatus = any;
export declare const ProjectType: any;
export type ProjectType = any;
export declare const UserRole: any;
export type UserRole = any;
export declare const WorkflowKind: any;
export type WorkflowKind = any;
export declare const GrokBatchJobStatus: any;
export type GrokBatchJobStatus = any;
export declare const BlogPostSource: any;
export type BlogPostSource = any;
export declare const ProductFeedImportItemStatus: any;
export type ProductFeedImportItemStatus = any;

export declare namespace Prisma {
  type InputJsonValue = any;
  type TransactionClient = any;
  type BrandManifestUncheckedCreateInput = any;
  type ClientSiteTutorialDraftUncheckedCreateInput = any;
  type ProductAnalogCreateManyInput = any;
  type ProductItemUpdateInput = any;
  const AnyNull: any;
  const DbNull: any;
  const JsonNull: any;
  class PrismaClientKnownRequestError extends Error {
    code: string;
    meta?: Record<string, unknown>;
  }
}
