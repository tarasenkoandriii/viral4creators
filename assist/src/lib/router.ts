/**
 * Hash-роутер, как во `frontend/src/lib/router.ts`: статический бандл на
 * Vercel и в Telegram; единственный rewrite (`vercel.json`) — прокси
 * `/api/*`, путь страницы всегда `/`, маршрут живёт в hash; URL — единственное состояние
 * навигации, BackButton Telegram — просто `history.back()`.
 */

import { useEffect, useState } from 'react';

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
  if (p.length === 1 && (SECTIONS as string[]).includes(p[0])) {
    return { name: 'section', section: p[0] as Section };
  }
  if (p[0] === 'sites') {
    if (p.length === 1) return { name: 'sites' };
    if (p.length === 2 && p[1] === 'new') return { name: 'site-new' };
    if (p.length === 2 && ID.test(p[1])) return { name: 'site', siteId: p[1] };
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
