/**
 * Minimal hash router — `#/projects`, `#/projects/:id`, `#/generate`…
 *
 * Why hash and not a router library: the app is a single static bundle
 * served as a Telegram Mini App and from Vercel — hash routes need no
 * server rewrites, survive the TMA's in-place reloads, and keep the
 * dependency list unchanged. The URL is the only navigation state, so a
 * screen can be deep-linked and the Telegram BackButton can simply call
 * history.back().
 */

import { useEffect, useState } from 'react';

export type Route =
  | { name: 'projects' }
  | { name: 'project-new' }
  | { name: 'project'; projectId: string }
  | { name: 'item'; projectId: string; itemId: string; step?: string }
  | {
      name: 'catalog-batch-start';
      projectId: string;
      sourceSessionId: string;
    }
  | { name: 'catalog-batch'; projectId: string; batchId: string }
  | { name: 'ab-test'; projectId: string; runId: string }
  | { name: 'feed-import-start'; projectId: string }
  | { name: 'feed-import'; projectId: string; runId: string }
  | { name: 'site-tutorial'; projectId: string; step?: string }
  | { name: 'greeting-video'; projectId: string }
  | { name: 'generate' }
  | { name: 'postprod' }
  | { name: 'postprod-video'; sessionId: string }
  | { name: 'manifests' }
  | { name: 'manifest-new' }
  | { name: 'manifest'; manifestId: string }
  | { name: 'legal'; slug: string }
  | { name: 'plan' }
  | { name: 'channels' }
  | { name: 'credits' }
  | { name: 'api-keys' }
  | { name: 'feed' }
  | { name: 'invite' }
  | { name: 'not-found'; path: string };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  const parts = path ? path.split('/') : [];

  if (parts.length === 0 || parts[0] === 'projects') {
    if (parts.length <= 1) return { name: 'projects' };
    if (parts[1] === 'new') return { name: 'project-new' };
    if (parts.length === 2) return { name: 'project', projectId: parts[1] };
    if (parts[2] === 'items' && parts[3]) {
      return {
        name: 'item',
        projectId: parts[1],
        itemId: parts[3],
        step: parts[4],
      };
    }
    // Этап 65 (ТЗ §44): /projects/:id/catalog-batch/start/:sourceSessionId
    // (выбор товаров) и /projects/:id/catalog-batch/:batchId (прогресс) —
    // различаются третьим сегментом ('start' — литерал, не встречается
    // среди cuid-идентификаторов партий).
    if (parts[2] === 'catalog-batch' && parts[3] === 'start' && parts[4]) {
      return {
        name: 'catalog-batch-start',
        projectId: parts[1],
        sourceSessionId: parts[4],
      };
    }
    if (parts[2] === 'catalog-batch' && parts[3]) {
      return {
        name: 'catalog-batch',
        projectId: parts[1],
        batchId: parts[3],
      };
    }
    // Этап 66 (TODO §III.6): /projects/:id/ab-test/:runId (прогресс) —
    // без отдельного «start»-экрана в отличие от catalog-batch, нечего
    // выбирать (фиксировано 3 варианта, решение владельца продукта).
    if (parts[2] === 'ab-test' && parts[3]) {
      return {
        name: 'ab-test',
        projectId: parts[1],
        runId: parts[3],
      };
    }
    // Этап 68 (TODO §Уровень 2 п.8): /projects/:id/feed-import (форма
    // ссылки) и /projects/:id/feed-import/:runId (прогресс) —
    // различаются наличием четвёртого сегмента, тот же приём, что у
    // ab-test (без отдельного литерала 'start', в отличие от
    // catalog-batch: тут нечего выбирать заранее, кроме самой ссылки).
    if (parts[2] === 'feed-import' && parts[3]) {
      return {
        name: 'feed-import',
        projectId: parts[1],
        runId: parts[3],
      };
    }
    // Этап 115 (§11 doc/CLIENT-SITE-TUTORIAL-SPEC.md): визард обучалки
    // по сайту заказчика.
    //
    // Сегмент шага добавлен «Тонкой красной линией» (§4.3): без него
    // «вернуться на просмотр» не переживало перезагрузку вкладки, а
    // кнопка «назад» браузера уводила из визарда целиком. Сегмента
    // может не быть — ссылки, выданные до этого этапа, обязаны
    // продолжать работать (`clientSiteUrlStep`).
    if (parts[2] === 'site-tutorial') {
      return { name: 'site-tutorial', projectId: parts[1], step: parts[3] };
    }
    // GREETING_VIDEO (ТЗ TZ-Greeting-Video-Project-Type.md) — тот же
    // приём, что site-tutorial: один маршрут/визард на весь путь
    // (бриф → референсы → сценарий → видео), состояния определяются
    // тем, что уже есть у проекта/сессии, а не сегментами адреса.
    if (parts[2] === 'greeting-video') {
      return { name: 'greeting-video', projectId: parts[1] };
    }
    if (parts[2] === 'feed-import') {
      return { name: 'feed-import-start', projectId: parts[1] };
    }
  }
  if (parts[0] === 'generate') return { name: 'generate' };
  // Этап 88: /postprod (список готовых роликов) и /postprod/:sessionId
  // (переозвучка/экспорт/публикация/шаринг одного ролика) — тот же
  // двухсегментный приём, что у /brand-manifests/:id ниже.
  if (parts[0] === 'postprod') {
    if (parts.length === 1) return { name: 'postprod' };
    if (parts[1]) return { name: 'postprod-video', sessionId: parts[1] };
  }
  if (parts[0] === 'plan') return { name: 'plan' };
  if (parts[0] === 'channels') return { name: 'channels' };
  if (parts[0] === 'credits') return { name: 'credits' };
  if (parts[0] === 'api-keys') return { name: 'api-keys' };
  if (parts[0] === 'feed') return { name: 'feed' };
  if (parts[0] === 'invite') return { name: 'invite' };
  if (parts[0] === 'legal' && parts[1]) {
    return { name: 'legal', slug: parts[1] };
  }
  if (parts[0] === 'brand-manifests') {
    if (parts.length === 1) return { name: 'manifests' };
    if (parts[1] === 'new') return { name: 'manifest-new' };
    if (parts.length === 2) return { name: 'manifest', manifestId: parts[1] };
  }
  return { name: 'not-found', path };
}

export function navigate(to: string, replace = false): void {
  const hash = to.startsWith('#')
    ? to
    : `#${to.startsWith('/') ? to : `/${to}`}`;
  if (replace) window.history.replaceState(null, '', hash);
  else window.location.hash = hash;
  // replaceState doesn't fire hashchange — notify listeners ourselves.
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.hash)
  );
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export const routes = {
  projects: () => '/projects',
  projectNew: () => '/projects/new',
  project: (id: string) => `/projects/${id}`,
  item: (projectId: string, itemId: string, step?: string) =>
    `/projects/${projectId}/items/${itemId}${step ? `/${step}` : ''}`,
  catalogBatchStart: (projectId: string, sourceSessionId: string) =>
    `/projects/${projectId}/catalog-batch/start/${sourceSessionId}`,
  catalogBatch: (projectId: string, batchId: string) =>
    `/projects/${projectId}/catalog-batch/${batchId}`,
  abTest: (projectId: string, runId: string) =>
    `/projects/${projectId}/ab-test/${runId}`,
  feedImportStart: (projectId: string) => `/projects/${projectId}/feed-import`,
  siteTutorial: (projectId: string, step?: string) =>
    `/projects/${projectId}/site-tutorial${step ? `/${step}` : ''}`,
  greetingVideo: (projectId: string) => `/projects/${projectId}/greeting-video`,
  feedImport: (projectId: string, runId: string) =>
    `/projects/${projectId}/feed-import/${runId}`,
  generate: () => '/generate',
  postprod: () => '/postprod',
  postprodVideo: (sessionId: string) => `/postprod/${sessionId}`,
  manifests: () => '/brand-manifests',
  manifestNew: () => '/brand-manifests/new',
  manifest: (id: string) => `/brand-manifests/${id}`,
  legal: (slug: string) => `/legal/${slug}`,
  plan: () => '/plan',
  channels: () => '/channels',
  credits: () => '/credits',
  /** Ключи внешнего API (этап 145) — Premium. */
  apiKeys: () => '/api-keys',
  feed: () => '/feed',
  /** Кабинет «Пригласить» (этап 133): чем открывается стена. */
  invite: () => '/invite',
};
