/**
 * Deep-link «снять обучение для сайта помощника» (Э6 помощника): id сайта
 * из `startapp=cst_…` или `?assistSite=`, хранение до первого раунда,
 * адрес формы нового проекта обучалки. Привязку проверяет сервер.
 */
import assert from 'node:assert/strict';
import {
  assistSiteEntryUrl,
  assistSiteFromLaunch,
  captureAssistSiteLink,
  clearPendingAssistSite,
  pendingAssistSite,
} from '../src/lib/assist-site-link';
import { projectTypeFromSearch } from '../src/features/projects/landing-entry';

const store = new Map<string, string>();
const loc = { search: '', hash: '' };
(globalThis as unknown as { window: unknown }).window = {
  sessionStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
  location: loc,
};

// Разбор: оба пути, мусор — нет.
assert.equal(
  assistSiteFromLaunch('', '#tgWebAppData=x&tgWebAppStartParam=cst_site_1'),
  'site_1'
);
assert.equal(assistSiteFromLaunch('?assistSite=ck1', ''), 'ck1');
for (const [s, h] of [
  ['', '#tgWebAppStartParam=r_ABCDEFGH'],
  ['', '#tgWebAppStartParam=cst_'],
  ['?assistSite=../x', ''],
  ['?assistSite=' + 'a'.repeat(60), ''],
  ['', ''],
]) {
  assert.equal(assistSiteFromLaunch(s, h), null, `${s}${h}`);
}

// Запоминание до первого раунда и сброс.
loc.hash = '#tgWebAppData=x&tgWebAppStartParam=cst_siteA';
assert.equal(captureAssistSiteLink(), true);
assert.equal(pendingAssistSite(), 'siteA');
clearPendingAssistSite();
assert.equal(pendingAssistSite(), null);
loc.hash = '#tgWebAppStartParam=r_ABCDEFGH';
assert.equal(captureAssistSiteLink(), false);
assert.equal(pendingAssistSite(), null);

// Форма нового проекта: тип «сайт заказчика» выбран тем же разбором, что у лендинга.
const url = assistSiteEntryUrl('/');
assert.equal(url, '/?entry=site-tutorial#/projects/new');
assert.equal(projectTypeFromSearch(url.split('#')[0].slice(1)), 'CLIENT_SITE');

console.log('assist-site-link: deep-link помощника — ок');
