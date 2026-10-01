import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PUBLIC_PLATFORM_SUFFIXES,
  isPublicPlatformHost,
} from '../src/kit/hosts';
import { availableMethods } from '../src/kit/verification';

// Список публичных платформ — копия серверного (импортом нельзя: разные
// пакеты). Сверяем строку в строку с файлом сервера: расхождение значит,
// что экран предложит файл/мету, а сервер ответит METHOD_NOT_ALLOWED (или
// наоборот спрячет рабочий способ).
const server = readFileSync(
  new URL(
    '../../sites-backend/src/modules/site-core/hosts/host-normalize.ts',
    import.meta.url
  ),
  'utf8'
);
const m = server.match(
  /export const PUBLIC_PLATFORM_SUFFIXES\s*=\s*\[([\s\S]*?)\]\s*as const/
);
assert.ok(m, 'host-normalize.ts: нет PUBLIC_PLATFORM_SUFFIXES');
const serverList = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
assert.ok(serverList.length >= 10, 'список сервера подозрительно короткий');
assert.deepEqual([...PUBLIC_PLATFORM_SUFFIXES], serverList);

for (const s of serverList) {
  assert.equal(isPublicPlatformHost(`shop.${s}`), true, s);
  assert.deepEqual(
    availableMethods({ host: `x.${s}`, publicPlatform: false }),
    ['dns'],
    s
  );
}
assert.equal(isPublicPlatformHost('Shop.MyShopify.com'), true);
assert.equal(isPublicPlatformHost('notgithub.io'), false);
assert.deepEqual(
  availableMethods({ host: 'example.com', publicPlatform: false }),
  ['dns', 'file', 'meta']
);

console.log(
  `platforms: ok (${serverList.length} суффиксов сверено с сервером)`
);
