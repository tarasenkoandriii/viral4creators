import assert from 'node:assert/strict';
import { launchHashRoute } from '../src/kit/telegram';
import { parseRoute, routeHref, type Route } from '../src/lib/router';
import { launchAction } from '../src/lib/widget-view';

assert.deepEqual(parseRoute(''), { name: 'home' });
assert.deepEqual(parseRoute('#/'), { name: 'home' });
assert.deepEqual(parseRoute('#/sites'), { name: 'sites' });
assert.deepEqual(parseRoute('#/sites/'), { name: 'sites' });
assert.deepEqual(parseRoute('#/sites/new'), { name: 'site-new' });
assert.deepEqual(parseRoute('#/sites/ck1'), { name: 'site', siteId: 'ck1' });
assert.deepEqual(parseRoute('#/sites/ck1/hosts/h2'), {
  name: 'host',
  siteId: 'ck1',
  hostId: 'h2',
});
assert.deepEqual(parseRoute('#/knowledge'), {
  name: 'section',
  section: 'knowledge',
});
assert.deepEqual(parseRoute('#/widget'), {
  name: 'section',
  section: 'widget',
});
assert.deepEqual(parseRoute('#/dialogs'), {
  name: 'section',
  section: 'dialogs',
});
assert.deepEqual(parseRoute('#/members'), { name: 'members' });
assert.deepEqual(parseRoute('#/members/invite'), { name: 'invite' });
assert.deepEqual(parseRoute('#/sites/ck1/hosts/h2/access'), {
  name: 'host-access',
  siteId: 'ck1',
  hostId: 'h2',
});
assert.equal(parseRoute('#/sites/ck1/hosts/h2/other').name, 'not-found');
assert.equal(parseRoute('#/members/x').name, 'not-found');
assert.deepEqual(parseRoute('#/welcome'), { name: 'welcome' });
// Служебный hash Telegram, мусор и чужие сегменты — не наши пути.
assert.equal(
  parseRoute('#tgWebAppData=abc&tgWebAppVersion=7').name,
  'not-found'
);
assert.equal(parseRoute('#/sites/ck1/hosts').name, 'not-found');
assert.equal(parseRoute('#/sites/a%2Fb').name, 'not-found');
assert.equal(parseRoute('#/sites/ck1/extra').name, 'not-found');
assert.equal(parseRoute('#/knowledge/x').name, 'not-found');

// ── Э1: онбординг, песочница, знания, перенос (контракт Э1 §6) ───────
assert.deepEqual(parseRoute('#/onboarding/url'), { name: 'onboarding-url' });
assert.deepEqual(parseRoute('#/sites/ck1/sandbox'), {
  name: 'sandbox',
  siteId: 'ck1',
});
assert.deepEqual(parseRoute('#/sites/ck1/knowledge/site'), {
  name: 'knowledge',
  siteId: 'ck1',
  mode: 'site',
  tab: 'overview',
});
// Бот ссылается на …/knowledge/site/versions (уведомление об удержании).
assert.deepEqual(parseRoute('#/sites/ck1/knowledge/site/versions'), {
  name: 'knowledge',
  siteId: 'ck1',
  mode: 'site',
  tab: 'versions',
});
assert.deepEqual(parseRoute('#/sites/ck1/knowledge/admin'), {
  name: 'knowledge',
  siteId: 'ck1',
  mode: 'admin',
  tab: 'overview',
});
assert.deepEqual(parseRoute('#/sites/ck1/knowledge/admin/versions'), {
  name: 'knowledge',
  siteId: 'ck1',
  mode: 'admin',
  tab: 'versions',
});
assert.equal(parseRoute('#/sites/ck1/knowledge/both').name, 'not-found');
assert.equal(parseRoute('#/sites/ck1/knowledge').name, 'not-found');
assert.equal(parseRoute('#/sites/ck1/knowledge/site/nope').name, 'not-found');
assert.equal(
  parseRoute('#/sites/ck1/knowledge/site/versions/2').name,
  'not-found'
);
assert.deepEqual(parseRoute('#/sandbox-transfer/AbC_-9'), {
  name: 'sandbox-transfer',
  sandboxId: 'AbC_-9',
});
assert.equal(parseRoute('#/sandbox-transfer/a.b').name, 'not-found');
assert.equal(parseRoute('#/onboarding').name, 'not-found');

const all: Route[] = [
  { name: 'home' },
  { name: 'welcome' },
  { name: 'sites' },
  { name: 'site-new' },
  { name: 'site', siteId: 's1' },
  { name: 'host', siteId: 's1', hostId: 'h1' },
  { name: 'host-access', siteId: 's1', hostId: 'h1' },
  { name: 'members' },
  { name: 'invite' },
  { name: 'section', section: 'knowledge' },
  { name: 'section', section: 'widget' },
  { name: 'section', section: 'dialogs' },
  { name: 'onboarding-url' },
  { name: 'sandbox', siteId: 's1' },
  { name: 'knowledge', siteId: 's1', mode: 'site', tab: 'overview' },
  { name: 'knowledge', siteId: 's1', mode: 'site', tab: 'quarantine' },
  { name: 'knowledge', siteId: 's1', mode: 'admin', tab: 'versions' },
  { name: 'sandbox-transfer', sandboxId: 'x1' },
  { name: 'widget', siteId: 's1', tab: 'look' },
  { name: 'widget', siteId: 's1', tab: 'install' },
  { name: 'widget', siteId: 's1', tab: 'hosts' },
  { name: 'widget', siteId: 's1', tab: 'leads' },
  { name: 'persona', siteId: 's1' },
  { name: 'wizard', siteId: 's1' },
  { name: 'plan', plan: 'business' },
  { name: 'widget-draft', draftId: 'd_1-x' },
];
// Сводка — без хвоста: ссылки бота короче и не зависят от вкладки.
assert.equal(
  routeHref({ name: 'knowledge', siteId: 's1', mode: 'site', tab: 'overview' }),
  '#/sites/s1/knowledge/site'
);
for (const r of all) assert.deepEqual(parseRoute(routeHref(r)), r);

// ═══ Запуск из кнопки бота: Telegram дописывает параметры к маршруту ═══
// (`#/путь?tgWebAppData=…`); очистка обязана оставить маршрут, иначе
// уведомление «версия удержана» открывает главную, а не «Версии».
const TG = 'tgWebAppData=query_id%3DA%26user%3D1&tgWebAppVersion=8.0';
assert.deepEqual(
  parseRoute(launchHashRoute(`#/sites/s1/knowledge/site/versions?${TG}`)),
  { name: 'knowledge', siteId: 's1', mode: 'site', tab: 'versions' }
);
assert.deepEqual(
  parseRoute(launchHashRoute(`#/sites/s1/knowledge/admin&${TG}`)),
  { name: 'knowledge', siteId: 's1', mode: 'admin', tab: 'overview' }
);
// Запуск без маршрута — пустой hash (главная), служебное не становится путём.
assert.equal(launchHashRoute(`#${TG}`), '');
assert.equal(launchHashRoute(`#/x=1?${TG}`), '');
// Обычный переход внутри приложения не трогается.
assert.equal(launchHashRoute('#/sites/s1'), '#/sites/s1');

// ═══ Э2 (W4): виджет, персона, мастер — адреса контракта Э2 §4 ═══════
assert.deepEqual(parseRoute('#/sites/ck1/widget'), {
  name: 'widget',
  siteId: 'ck1',
  tab: 'look',
});
assert.deepEqual(parseRoute('#/sites/ck1/widget/install'), {
  name: 'widget',
  siteId: 'ck1',
  tab: 'install',
});
// «Вид» — без хвоста: один адрес у одного экрана.
assert.equal(parseRoute('#/sites/ck1/widget/look').name, 'not-found');
assert.equal(
  routeHref({ name: 'widget', siteId: 's1', tab: 'look' }),
  '#/sites/s1/widget'
);
assert.equal(parseRoute('#/sites/ck1/widget/nope').name, 'not-found');
assert.equal(parseRoute('#/sites/ck1/widget/install/x').name, 'not-found');
assert.deepEqual(parseRoute('#/sites/ck1/persona'), {
  name: 'persona',
  siteId: 'ck1',
});
assert.deepEqual(parseRoute('#/sites/ck1/learning/site/onboarding'), {
  name: 'wizard',
  siteId: 'ck1',
});
assert.equal(
  parseRoute('#/sites/ck1/learning/admin/onboarding').name,
  'not-found'
);
assert.equal(parseRoute('#/plan/vip').name, 'not-found');
assert.equal(parseRoute('#/widget-draft/a.b').name, 'not-found');
assert.equal(parseRoute('#/sites/a%2Fb/widget').name, 'not-found');

// ═══ Payload лендинга → свой экран (приёмка «Л», контракт Э2 §7) ═══════
// Каждый payload открывает СВОЙ экран и уходит в атрибуцию целиком.
const screenOf = (sp: string) => {
  const a = launchAction(sp);
  return a.target ? parseRoute(routeHref(a.target as Route)) : null;
};
assert.deepEqual(screenOf('lp_spring_sale'), { name: 'onboarding-url' });
assert.deepEqual(screenOf('pl_business'), { name: 'plan', plan: 'business' });
assert.deepEqual(screenOf('sb_AbC-9'), {
  name: 'sandbox-transfer',
  sandboxId: 'AbC-9',
});
assert.deepEqual(screenOf('wd_x1Y2'), {
  name: 'widget-draft',
  draftId: 'x1Y2',
});
for (const sp of ['lp_spring_sale', 'pl_business', 'sb_AbC-9', 'wd_x1Y2']) {
  assert.equal(launchAction(sp).acquisition, sp);
}
// Неизвестный тариф — атрибуция есть, экрана нет (главная).
assert.deepEqual(launchAction('pl_vip'), {
  acquisition: 'pl_vip',
  target: null,
});
// Приглашение, мусор, пусто — ни атрибуции, ни экрана.
for (const sp of ['inv_abc', 'st_x', 'lp_<script>', 'xx_1', '', null]) {
  assert.deepEqual(launchAction(sp), { acquisition: null, target: null });
}

console.log('router: ok');
