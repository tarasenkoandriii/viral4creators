import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  APP_BUILD_PLACEHOLDER,
  appBuildVersion,
  injectAppBuildMeta,
} from '../app-build-meta';

// На Vercel — семь символов коммита, в нижнем регистре.
assert.equal(
  appBuildVersion({ VERCEL_GIT_COMMIT_SHA: 'A1B2C3D4E5F6A7B8C9D0' }),
  'a1b2c3d'
);
assert.equal(
  appBuildVersion({ VERCEL_GIT_COMMIT_SHA: ' a1b2c3d ' }),
  'a1b2c3d'
);

// Вне Vercel — dev, а не пустота.
assert.equal(appBuildVersion({}), 'dev');
assert.equal(appBuildVersion({ VERCEL_GIT_COMMIT_SHA: '' }), 'dev');
// «undefined» из шаблона и обрывки — не версия.
assert.equal(appBuildVersion({ VERCEL_GIT_COMMIT_SHA: 'undefined' }), 'dev');
assert.equal(appBuildVersion({ VERCEL_GIT_COMMIT_SHA: 'abc' }), 'dev');
// В атрибут HTML попадает только [0-9a-f] — ничего, что надо экранировать.
assert.equal(
  appBuildVersion({ VERCEL_GIT_COMMIT_SHA: '"><script>1234567' }),
  'dev'
);

// Подстановка.
assert.equal(
  injectAppBuildMeta(
    `<meta name="app-build" content="${APP_BUILD_PLACEHOLDER}" />`,
    'a1b2c3d'
  ),
  '<meta name="app-build" content="a1b2c3d" />'
);
// Без заглушки — громкий отказ, а не сборка без meta.
assert.throws(() => injectAppBuildMeta('<html></html>', 'dev'));

// Сам index.html заглушку содержит — ровно одну, в meta app-build.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
assert.equal(html.split(APP_BUILD_PLACEHOLDER).length - 1, 1);
assert.ok(
  html.includes(`<meta name="app-build" content="${APP_BUILD_PLACEHOLDER}" />`)
);

console.log('app-build-meta: ok');
