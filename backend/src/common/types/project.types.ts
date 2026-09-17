/**
 * Project / ProductItem API shapes — doc/PRODUCT-PROJECT-SPEC.md §2, §5,
 * §7. What the `project` module returns to the client; mirrored by hand
 * in frontend/src/types/project.ts (no shared package in this repo).
 *
 * Deliberately NOT the Prisma row types: Prisma's `Decimal` is turned into
 * a plain `number | null` here (prices carry 2 decimals, well within JS
 * number precision), and `isComplete` is computed, not stored.
 */

/** `CLIENT_SITE` — обучалка по сайту заказчика (этап 111 завёл значение
 * в БД, этап 115 — путь пользователя к нему). У такого проекта нет
 * `ProductItem` вообще: «товар» здесь — чужой сайт. */
export type ProjectType = 'SINGLE' | 'LINE' | 'CLIENT_SITE';

export type ProductPriceSource = 'MANUAL' | 'ANALOG';

import type { AudienceProfile } from './audience.types';

export interface ProductAnalogView {
  id: string;
  title: string;
  sourceUrl: string;
  price: number | null;
  /** Currency of the SOURCE listing — may differ from the project's. */
  currency: string | null;
  thumbnailUrl: string | null;
  relevanceRank: number;
}

export interface ProductItemView {
  id: string;
  projectId: string;
  title: string | null;
  photoUrl: string | null;
  description: string | null;
  /** Auto-detected from the photo (spec §6.1/§9.4); never user-entered. */
  category: string | null;
  /** Who buys it (spec §18): Gemini's read of the photo, editable by the user. */
  audience: AudienceProfile | null;
  /** In the project's currency. */
  price: number | null;
  priceSource: ProductPriceSource;
  /**
   * Spec §7.4 (decided): an item is "filled" when it has a price AND a
   * description — photo/analogs are optional conveniences, never gates.
   */
  isComplete: boolean;
  analogs: ProductAnalogView[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectView {
  id: string;
  type: ProjectType;
  title: string;
  /** ISO 3166-1 alpha-2. */
  countryCode: string;
  /** ISO 4217 — derived from countryCode, not user-editable (spec §7.2). */
  currency: string;
  brandManifestId: string | null;
  items: ProductItemView[];
  createdAt: string;
  updatedAt: string;
}

/** Row of GET /projects — no nested analogs, just enough for a list screen. */
export interface ProjectSummaryView {
  id: string;
  type: ProjectType;
  title: string;
  countryCode: string;
  currency: string;
  brandManifestId: string | null;
  itemCount: number;
  /** How many items satisfy `isComplete` — the list can show "2 / 5 filled". */
  completeItemCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Этап 89: «умный» алерт перед `DELETE /projects/:id` — счётчики ПРЯМЫХ
 * потомков проекта (`onDelete: Cascade` в schema.prisma), не полный
 * список того, что унесёт каскад. Не включает `sessions` — они
 * переживают удаление проекта (`SetNull`, не `Cascade`, см.
 * доккомментарий `Session.projectId` в schema.prisma).
 *
 * Уточнение (найдено доп. аудитом, MEDIUM — раньше здесь было сказано
 * «ровно то, что уносит каскад», что не так): у каждого `catalogBatchRuns`/
 * `abTestRuns`/`feedImportRuns` есть свои дочерние строки
 * (`CatalogBatchItem`/`AbTestVariant`/`ProductFeedImportItem`), которые
 * каскад унесёт вместе с родителем, но которые этот превью НЕ считает —
 * посчитать их отдельным запросом ради текста диалога сочли не стоящим
 * ещё одного JOIN/COUNT на каждое удаление; сам текст диалога
 * (`deleteConfirm.willDelete` в словарях) уже сформулирован как список
 * «что уйдёт», а не как исчерпывающий счёт всех строк БД, так что
 * неполнота здесь — известное упрощение, не баг.
 */
export interface ProjectDeletePreview {
  items: number;
  catalogBatchRuns: number;
  abTestRuns: number;
  feedImportRuns: number;
}

/** То же самое, только для одного товара (`DELETE .../items/:itemId`). */
export interface ItemDeletePreview {
  analogs: number;
  catalogBatchItems: number;
}
