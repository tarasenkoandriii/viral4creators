/**
 * Hash-роутер, как во `frontend/src/lib/router.ts`: статический бандл на
 * Vercel и в Telegram; единственный rewrite (`vercel.json`) — прокси
 * `/api/*`, путь страницы всегда `/`, маршрут живёт в hash; URL — единственное состояние
 * навигации, BackButton Telegram — просто `history.back()`.
 */

import { useEffect, useState } from 'react';
import type { KnowledgeMode } from './knowledge-types';
import {
  isKnowledgeMode,
  isKnowledgeTab,
  type KnowledgeTab,
} from './knowledge-view';
import { PLAN_IDS, isWidgetTab, type WidgetTab } from './widget-view';
import {
  isLearningTab,
  isStatsTab,
  type LearningTab,
  type StatsTab,
} from './e3-view';

export type Section = 'knowledge' | 'widget' | 'dialogs';

export type Route =
  | { name: 'home' }
  | { name: 'welcome' }
  | { name: 'sites' }
  | { name: 'site-new' }
  | { name: 'site'; siteId: string }
  | { name: 'host'; siteId: string; hostId: string }
  | { name: 'host-access'; siteId: string; hostId: string }
  | { name: 'members' }
  | { name: 'invite' }
  | { name: 'section'; section: Section }
  // Э1: онбординг шаги 2–3, песочница, знания, перенос песочницы лендинга
  // (контракт Э1 §6, «Хеш-маршруты TMA» — бот ссылается на них).
  | { name: 'onboarding-url' }
  | { name: 'sandbox'; siteId: string }
  | {
      name: 'knowledge';
      siteId: string;
      mode: KnowledgeMode;
      tab: KnowledgeTab;
    }
  | { name: 'sandbox-transfer'; sandboxId: string }
  // Э2: виджет (вкладки Вид/Установка/Где работает/Лиды), персона, мастер
  // «Научите помощника», экраны payload лендинга (контракт Э2 §4 W4).
  | { name: 'widget'; siteId: string; tab: WidgetTab }
  | { name: 'persona'; siteId: string }
  | { name: 'wizard'; siteId: string }
  | { name: 'plan'; plan: string }
  | { name: 'widget-draft'; draftId: string }
  // Э3 (T): диалоги и передача, статистика, цели, интеграции, обучение
  // (контракт Э3 §4 T, «TMA (хеш-маршруты)»; бот ссылается на них).
  | { name: 'dialogs'; siteId: string }
  | { name: 'dialog'; siteId: string; cid: string }
  | { name: 'handoff'; siteId: string }
  | { name: 'stats'; siteId: string; tab: StatsTab }
  | { name: 'stats-sites' }
  | { name: 'goals'; siteId: string }
  | { name: 'integrations'; siteId: string }
  | { name: 'learning'; siteId: string; tab: LearningTab }
  // Э4: тариф и оплата (§3.10); `#/billing/<тариф>` — выбранный тариф
  // (payload `pl_` лендинга, кнопка «Оплатить»).
  | { name: 'billing'; plan: string | null }
  // Э6: ролики обучалки сайта и карта «показать на экране».
  | { name: 'videos'; siteId: string }
  // Э-С Ш2: тестовые учётные записи сайта (общие с обучалкой и QA).
  | { name: 'test-accounts'; siteId: string }
  | { name: 'not-found'; path: string };

const SECTIONS: Section[] = ['knowledge', 'widget', 'dialogs'];
// Идентификаторы — cuid и подобные; всё прочее в сегменте — не наш путь.
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  const p = path ? path.split('/') : [];

  if (p.length === 0) return { name: 'home' };
  if (p.length === 1 && p[0] === 'welcome') return { name: 'welcome' };
  if (p.length === 1 && p[0] === 'members') return { name: 'members' };
  if (p.length === 2 && p[0] === 'members' && p[1] === 'invite') {
    return { name: 'invite' };
  }
  if (p.length === 2 && p[0] === 'onboarding' && p[1] === 'url') {
    return { name: 'onboarding-url' };
  }
  if (p.length === 2 && p[0] === 'sandbox-transfer' && ID.test(p[1])) {
    return { name: 'sandbox-transfer', sandboxId: p[1] };
  }
  if (
    p.length === 2 &&
    p[0] === 'plan' &&
    (PLAN_IDS as readonly string[]).includes(p[1])
  ) {
    return { name: 'plan', plan: p[1] };
  }
  if (p.length === 2 && p[0] === 'widget-draft' && ID.test(p[1])) {
    return { name: 'widget-draft', draftId: p[1] };
  }
  if (p.length === 1 && p[0] === 'stats') return { name: 'stats-sites' };
  if (p.length === 1 && p[0] === 'billing') {
    return { name: 'billing', plan: null };
  }
  if (
    p.length === 2 &&
    p[0] === 'billing' &&
    (PLAN_IDS as readonly string[]).includes(p[1]) &&
    p[1] !== 'trial'
  ) {
    return { name: 'billing', plan: p[1] };
  }
  if (p.length === 1 && (SECTIONS as string[]).includes(p[0])) {
    return { name: 'section', section: p[0] as Section };
  }
  if (p[0] === 'sites') {
    if (p.length === 1) return { name: 'sites' };
    if (p.length === 2 && p[1] === 'new') return { name: 'site-new' };
    if (p.length === 2 && ID.test(p[1])) return { name: 'site', siteId: p[1] };
    if (p.length === 3 && p[2] === 'sandbox' && ID.test(p[1])) {
      return { name: 'sandbox', siteId: p[1] };
    }
    // #/sites/:id/knowledge/site|admin[/вкладка]; без вкладки — сводка.
    if (
      (p.length === 4 || p.length === 5) &&
      p[2] === 'knowledge' &&
      ID.test(p[1]) &&
      isKnowledgeMode(p[3]) &&
      (p.length === 4 || isKnowledgeTab(p[4]))
    ) {
      return {
        name: 'knowledge',
        siteId: p[1],
        mode: p[3],
        tab: p.length === 5 ? (p[4] as KnowledgeTab) : 'overview',
      };
    }
    // #/sites/:id/widget[/вкладка]; без вкладки — «Вид».
    if (
      (p.length === 3 || p.length === 4) &&
      p[2] === 'widget' &&
      ID.test(p[1]) &&
      (p.length === 3 || (isWidgetTab(p[3]) && p[3] !== 'look'))
    ) {
      return {
        name: 'widget',
        siteId: p[1],
        tab: p.length === 4 ? (p[3] as WidgetTab) : 'look',
      };
    }
    if (p.length === 3 && p[2] === 'persona' && ID.test(p[1])) {
      return { name: 'persona', siteId: p[1] };
    }
    if (p.length === 3 && p[2] === 'videos' && ID.test(p[1])) {
      return { name: 'videos', siteId: p[1] };
    }
    if (p.length === 3 && p[2] === 'test-accounts' && ID.test(p[1])) {
      return { name: 'test-accounts', siteId: p[1] };
    }
    if (p.length === 3 && p[2] === 'dialogs' && ID.test(p[1])) {
      return { name: 'dialogs', siteId: p[1] };
    }
    if (
      p.length === 4 &&
      p[2] === 'dialogs' &&
      ID.test(p[1]) &&
      ID.test(p[3])
    ) {
      return { name: 'dialog', siteId: p[1], cid: p[3] };
    }
    if (p.length === 3 && ID.test(p[1])) {
      if (p[2] === 'handoff') return { name: 'handoff', siteId: p[1] };
      if (p[2] === 'goals') return { name: 'goals', siteId: p[1] };
      if (p[2] === 'integrations') {
        return { name: 'integrations', siteId: p[1] };
      }
    }
    // #/sites/:id/stats[/overview|conversions|topics]; без вкладки — обзор.
    if (
      (p.length === 3 || p.length === 4) &&
      p[2] === 'stats' &&
      ID.test(p[1]) &&
      (p.length === 3 || (isStatsTab(p[3]) && p[3] !== 'overview'))
    ) {
      return {
        name: 'stats',
        siteId: p[1],
        tab: p.length === 4 ? (p[3] as StatsTab) : 'overview',
      };
    }
    // #/sites/:id/learning/site[/queue|golden|quality]; без вкладки — очередь.
    if (
      (p.length === 4 || p.length === 5) &&
      p[2] === 'learning' &&
      p[3] === 'site' &&
      ID.test(p[1]) &&
      (p.length === 4 || (isLearningTab(p[4]) && p[4] !== 'queue'))
    ) {
      return {
        name: 'learning',
        siteId: p[1],
        tab: p.length === 5 ? (p[4] as LearningTab) : 'queue',
      };
    }
    // Мастер — адрес из ТЗ §4-тер.14: …/learning/site/onboarding.
    if (
      p.length === 5 &&
      p[2] === 'learning' &&
      p[3] === 'site' &&
      p[4] === 'onboarding' &&
      ID.test(p[1])
    ) {
      return { name: 'wizard', siteId: p[1] };
    }
    if (p.length === 4 && p[2] === 'hosts' && ID.test(p[1]) && ID.test(p[3])) {
      return { name: 'host', siteId: p[1], hostId: p[3] };
    }
    if (
      p.length === 5 &&
      p[2] === 'hosts' &&
      p[4] === 'access' &&
      ID.test(p[1]) &&
      ID.test(p[3])
    ) {
      return { name: 'host-access', siteId: p[1], hostId: p[3] };
    }
  }
  return { name: 'not-found', path };
}

export function routeHref(r: Route): string {
  switch (r.name) {
    case 'home':
      return '#/';
    case 'welcome':
      return '#/welcome';
    case 'sites':
      return '#/sites';
    case 'site-new':
      return '#/sites/new';
    case 'site':
      return `#/sites/${r.siteId}`;
    case 'host':
      return `#/sites/${r.siteId}/hosts/${r.hostId}`;
    case 'host-access':
      return `#/sites/${r.siteId}/hosts/${r.hostId}/access`;
    case 'members':
      return '#/members';
    case 'invite':
      return '#/members/invite';
    case 'section':
      return `#/${r.section}`;
    case 'onboarding-url':
      return '#/onboarding/url';
    case 'sandbox':
      return `#/sites/${r.siteId}/sandbox`;
    case 'knowledge':
      return `#/sites/${r.siteId}/knowledge/${r.mode}${
        r.tab === 'overview' ? '' : `/${r.tab}`
      }`;
    case 'sandbox-transfer':
      return `#/sandbox-transfer/${r.sandboxId}`;
    case 'widget':
      return `#/sites/${r.siteId}/widget${r.tab === 'look' ? '' : `/${r.tab}`}`;
    case 'persona':
      return `#/sites/${r.siteId}/persona`;
    case 'videos':
      return `#/sites/${r.siteId}/videos`;
    case 'test-accounts':
      return `#/sites/${r.siteId}/test-accounts`;
    case 'wizard':
      return `#/sites/${r.siteId}/learning/site/onboarding`;
    case 'plan':
      return `#/plan/${r.plan}`;
    case 'widget-draft':
      return `#/widget-draft/${r.draftId}`;
    case 'dialogs':
      return `#/sites/${r.siteId}/dialogs`;
    case 'dialog':
      return `#/sites/${r.siteId}/dialogs/${r.cid}`;
    case 'handoff':
      return `#/sites/${r.siteId}/handoff`;
    case 'stats':
      return `#/sites/${r.siteId}/stats${
        r.tab === 'overview' ? '' : `/${r.tab}`
      }`;
    case 'stats-sites':
      return '#/stats';
    case 'goals':
      return `#/sites/${r.siteId}/goals`;
    case 'integrations':
      return `#/sites/${r.siteId}/integrations`;
    case 'learning':
      return `#/sites/${r.siteId}/learning/site${
        r.tab === 'queue' ? '' : `/${r.tab}`
      }`;
    case 'billing':
      return r.plan ? `#/billing/${r.plan}` : '#/billing';
    case 'not-found':
      return `#/${r.path}`;
  }
}

export function navigate(r: Route, replace = false): void {
  const href = routeHref(r);
  if (replace) {
    window.history.replaceState(null, '', href);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = href;
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
