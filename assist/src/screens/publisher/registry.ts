/**
 * AI Publisher — РЕЕСТР разделов и карточек обзора (§14.1, §16.0, §16.9).
 *
 * Единственная общая точка P-G1 и P-G2: оболочка (`PublisherShell`)
 * строит навигацию и маршруты `#/sites/:siteId/publisher/<key>[/<id>]` по
 * этому массиву. P-G2 добавляет ОДНУ строку на экран в свой блок
 * `── P-G2 ──` и не трогает `App.tsx`/`router.ts`. Контракт —
 * `<scratchpad>/pub-g-shell.md`.
 *
 * `actions` — подсказка видимости вкладки по матрице §4.2 (любое из
 * действий); решает сервер (AT-CORE-11).
 */

import type { ComponentType } from 'react';
import {
  Bot,
  BookOpen,
  CalendarDays,
  ClipboardCheck,
  FileText,
  HelpCircle,
  ListChecks,
  Rocket,
  ScrollText,
  ShieldCheck,
  Tag,
  type LucideIcon,
} from 'lucide-react';
import type { Locale } from '../../kit';
import { getPublisherDict } from '../../lib/publisher/i18n';
import type { PubAction } from '../../lib/publisher/permissions';
import type { PubQuery } from './publisher-context';
import { LaunchScreen } from './core/LaunchScreen';
import { RolesScreen } from './core/RolesScreen';
import { AuditScreen } from './core/AuditScreen';
import { ReviewTasksCard } from './core/ReviewTasksCard';
import { SourcesScreen } from './content/SourcesScreen';
import { QuestionsScreen } from './content/QuestionsScreen';
import { BrandScreen } from './content/BrandScreen';
import { PlanScreen } from './content/PlanScreen';
import { BriefScreen } from './content/BriefScreen';
import { MaterialsScreen } from './content/MaterialsScreen';
import { QaQueueScreen } from './content/QaQueueScreen';
import { CalendarScreen } from './content/CalendarScreen';
import { AiScreen } from './content/AiScreen';
import { DueCard } from './core/DueCard';
import { opsHomeCards as G2C, opsSections as G2 } from './ops/sections'; // P-G2

export type PublisherNavGroup =
  | 'start'
  | 'content'
  | 'distribution'
  | 'money'
  | 'leads'
  | 'analytics'
  | 'admin';

export const NAV_GROUPS: readonly PublisherNavGroup[] = [
  'start',
  'content',
  'distribution',
  'money',
  'leads',
  'analytics',
  'admin',
];

export interface PublisherSectionProps {
  /** `<раздел>/<id>` — карточка; `null` — список. */
  id: string | null;
  /** Фильтры из `?k=v` маршрута. */
  query: PubQuery;
}

export interface PublisherSection {
  /** Сегмент URL: `/^[a-z][a-z0-9-]{0,31}$/`, уникален. */
  key: string;
  owner: 'P-G1' | 'P-G2';
  group: PublisherNavGroup;
  order: number;
  icon: LucideIcon;
  label: (locale: Locale) => string;
  actions?: readonly PubAction[];
  Screen: ComponentType<PublisherSectionProps>;
}

export interface PublisherHomeCard {
  key: string;
  owner: 'P-G1' | 'P-G2';
  order: number;
  actions?: readonly PubAction[];
  /** Без пропсов: всё — из `usePublisher()`. */
  Card: ComponentType;
}

const g1 =
  (k: keyof ReturnType<typeof getPublisherDict>['nav']) => (l: Locale) =>
    String(getPublisherDict(l).nav[k]);

export const PUBLISHER_SECTIONS: readonly PublisherSection[] = [
  // ── P-G1 ──
  {
    key: 'launch',
    owner: 'P-G1',
    group: 'start',
    order: 10,
    icon: Rocket,
    label: g1('launch'),
    Screen: LaunchScreen,
  },
  {
    key: 'sources',
    owner: 'P-G1',
    group: 'content',
    order: 10,
    icon: BookOpen,
    label: g1('sources'),
    Screen: SourcesScreen,
  },
  {
    key: 'questions',
    owner: 'P-G1',
    group: 'content',
    order: 20,
    icon: HelpCircle,
    label: g1('questions'),
    Screen: QuestionsScreen,
  },
  {
    key: 'brand',
    owner: 'P-G1',
    group: 'content',
    order: 30,
    icon: Tag,
    label: g1('brand'),
    Screen: BrandScreen,
  },
  {
    key: 'plan',
    owner: 'P-G1',
    group: 'content',
    order: 40,
    icon: ListChecks,
    label: g1('plan'),
    Screen: PlanScreen,
  },
  {
    key: 'briefs',
    owner: 'P-G1',
    group: 'content',
    order: 41,
    icon: FileText,
    label: g1('plan'),
    Screen: BriefScreen,
  },
  {
    key: 'materials',
    owner: 'P-G1',
    group: 'content',
    order: 50,
    icon: FileText,
    label: g1('materials'),
    Screen: MaterialsScreen,
  },
  {
    key: 'qa',
    owner: 'P-G1',
    group: 'content',
    order: 60,
    icon: ClipboardCheck,
    label: g1('qa'),
    Screen: QaQueueScreen,
  },
  {
    key: 'calendar',
    owner: 'P-G1',
    group: 'distribution',
    order: 10,
    icon: CalendarDays,
    label: g1('calendar'),
    Screen: CalendarScreen,
  },
  {
    key: 'ai',
    owner: 'P-G1',
    group: 'admin',
    order: 10,
    icon: Bot,
    label: g1('ai'),
    actions: ['ai.generate', 'ai.helper', 'ai.bind', 'ai.eval.review'],
    Screen: AiScreen,
  },
  {
    key: 'roles',
    owner: 'P-G1',
    group: 'admin',
    order: 20,
    icon: ShieldCheck,
    label: g1('roles'),
    actions: ['role.manage'],
    Screen: RolesScreen,
  },
  {
    key: 'audit',
    owner: 'P-G1',
    group: 'admin',
    order: 30,
    icon: ScrollText,
    label: g1('audit'),
    actions: ['audit.read'],
    Screen: AuditScreen,
  },
  // ── P-G2 ── (одна строка на экран; группы: distribution/money/leads/analytics/admin)
  G2.venues,
  G2.purchases,
  G2.budget,
  G2.leads,
  G2.traffic,
  G2.experiments,
  G2.reports,
  G2.time,
  G2.backups,
];

/** Разделы, которые не показываются вкладкой (карточки внутри других). */
export const HIDDEN_SECTIONS: ReadonlySet<string> = new Set(['briefs']);

export const PUBLISHER_HOME_CARDS: readonly PublisherHomeCard[] = [
  // ── P-G1 ──
  { key: 'review', owner: 'P-G1', order: 10, Card: ReviewTasksCard },
  { key: 'due', owner: 'P-G1', order: 20, Card: DueCard },
  // ── P-G2 ── (предупреждения бюджета, просроченные первые контакты, очередь, интеграции)
  G2C.budget,
  G2C.leads,
  G2C.integrations,
];

export function findSection(key: string | null): PublisherSection | null {
  if (!key) return null;
  return PUBLISHER_SECTIONS.find((s) => s.key === key) ?? null;
}
