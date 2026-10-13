/**
 * Разделы и карточки обзора P-G2 для реестра оболочки
 * (`../registry.ts`, блоки `── P-G2 ──`: одна строка на экран).
 * Подписи — из словаря `publisher-ops-*`; `actions` — подсказка
 * видимости по матрице §4.2 (решает сервер, AT-CORE-11).
 */
import {
  Activity,
  Archive,
  BarChart3,
  Clock,
  FlaskConical,
  Inbox,
  ShoppingCart,
  Store,
  Wallet,
} from 'lucide-react';
import type { Locale } from '../../../kit';
import {
  getOpsDict,
  type PublisherOpsDict,
} from '../../../lib/publisher/ops-view';
import type { PublisherHomeCard, PublisherSection } from '../registry';
import { BackupsSection } from './BackupsScreen';
import { BudgetSection } from './BudgetScreen';
import { ExperimentsSection } from './ExperimentsScreen';
import {
  BudgetHomeCard,
  IntegrationsHomeCard,
  LeadsHomeCard,
} from './HomeCards';
import { LeadsSection } from './LeadsScreen';
import { PurchasesSection } from './PurchasesScreen';
import { ReportsSection } from './ReportsScreen';
import { TimeSection } from './TimeScreen';
import { TrafficSection } from './TrafficScreen';
import { VenuesSection } from './VenuesScreen';

const label = (k: keyof PublisherOpsDict['nav']) => (l: Locale) =>
  getOpsDict(l).nav[k];

export const opsSections = {
  venues: {
    key: 'venues',
    owner: 'P-G2',
    group: 'distribution',
    order: 20,
    icon: Store,
    label: label('venues'),
    Screen: VenuesSection,
  },
  purchases: {
    key: 'purchases',
    owner: 'P-G2',
    group: 'money',
    order: 10,
    icon: ShoppingCart,
    label: label('purchases'),
    Screen: PurchasesSection,
  },
  budget: {
    key: 'budget',
    owner: 'P-G2',
    group: 'money',
    order: 20,
    icon: Wallet,
    label: label('budget'),
    Screen: BudgetSection,
  },
  leads: {
    key: 'leads',
    owner: 'P-G2',
    group: 'leads',
    order: 10,
    icon: Inbox,
    label: label('leads'),
    actions: ['lead.read'],
    Screen: LeadsSection,
  },
  traffic: {
    key: 'traffic',
    owner: 'P-G2',
    group: 'leads',
    order: 20,
    icon: Activity,
    label: label('traffic'),
    actions: ['traffic.read', 'traffic.diagnostics'],
    Screen: TrafficSection,
  },
  experiments: {
    key: 'experiments',
    owner: 'P-G2',
    group: 'analytics',
    order: 10,
    icon: FlaskConical,
    label: label('experiments'),
    Screen: ExperimentsSection,
  },
  reports: {
    key: 'reports',
    owner: 'P-G2',
    group: 'analytics',
    order: 20,
    icon: BarChart3,
    label: label('reports'),
    Screen: ReportsSection,
  },
  time: {
    key: 'time',
    owner: 'P-G2',
    group: 'analytics',
    order: 30,
    icon: Clock,
    label: label('time'),
    actions: ['time.own', 'time.others'],
    Screen: TimeSection,
  },
  backups: {
    key: 'backups',
    owner: 'P-G2',
    group: 'admin',
    order: 40,
    icon: Archive,
    label: label('backups'),
    actions: ['backup.manage', 'restore.dry_run', 'restore.apply'],
    Screen: BackupsSection,
  },
} as const satisfies Record<string, PublisherSection>;

export const opsHomeCards = {
  budget: { key: 'ops-budget', owner: 'P-G2', order: 30, Card: BudgetHomeCard },
  leads: {
    key: 'ops-leads',
    owner: 'P-G2',
    order: 40,
    actions: ['lead.read'],
    Card: LeadsHomeCard,
  },
  integrations: {
    key: 'ops-integrations',
    owner: 'P-G2',
    order: 50,
    actions: ['metrics.import'],
    Card: IntegrationsHomeCard,
  },
} as const satisfies Record<string, PublisherHomeCard>;
