/**
 * AI Publisher (P-G1) — контекст экранов раздела: продукт, роли, клиенты
 * и навигация внутри раздела. Ставит `PublisherShell`; экраны P-G1 и P-G2
 * читают его через `usePublisher()`. Файл `.ts` без JSX (как
 * `kit-context.ts`): правило react-refresh не спорит с экспортом хука.
 */

import { createContext, useContext } from 'react';
import type { Locale } from '../../kit';
import type { PublisherHttp } from '../../lib/publisher/common-api';
import type { ProductView } from '../../lib/publisher/core-api';
import type { PublisherDict } from '../../lib/publisher/i18n';
import type { MyRoles, PubAction } from '../../lib/publisher/permissions';

export type PubQuery = Readonly<Record<string, string>>;

export interface PublisherValue {
  siteId: string;
  product: ProductView;
  roles: MyRoles;
  /** Подсказка интерфейса по матрице §4.2; решает сервер. */
  can: (action: PubAction) => boolean;
  /** Перечитать продукт и краткие гейты (после режима/параметров). */
  reloadProduct: () => void;
  /** JSON-клиент `/publisher/*` (таймаут кита 30 с). */
  http: PublisherHttp;
  /** Тот же клиент с таймаутом 65 с — только AI-операции (§14.1). */
  aiHttp: PublisherHttp;
  locale: Locale;
  t: PublisherDict;
  /** Ссылка внутри раздела: `#/sites/:siteId/publisher/<section>/<id>?…`. */
  href: (
    section?: string | null,
    id?: string | null,
    query?: PubQuery
  ) => string;
  go: (section?: string | null, id?: string | null, query?: PubQuery) => void;
  /** id участника кабинета (для фильтра «мои», выдачи ролей). */
  memberId: string;
}

export const PublisherContext = createContext<PublisherValue | null>(null);

export function usePublisher(): PublisherValue {
  const v = useContext(PublisherContext);
  if (!v) throw new Error('usePublisher() вызван вне <PublisherShell>');
  return v;
}
