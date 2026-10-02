/**
 * Документация и страницы платформ ↔ продукт (Л5): всё, что разработчик
 * заказчика скопирует с лендинга, совпадает с тем, что продукт выдаёт и
 * принимает. Источники — код, а не наш пересказ:
 *
 *  1. Публичные имена `brand.ts` (`PRODUCT_NAMES`, `WIDGET_NAMES`) — те же,
 *     что в `sites-backend/src/brand.ts` и зеркалах `assist-integrations`
 *     (npm, плагин WordPress); путь страницы бота в User-Agent обходчика —
 *     это наша страница `/assistant/bot`.
 *  2. Код вставки, CSP и шаблон GTM — побайтно равны выводу настоящих
 *     `buildEmbedSnippet` / `buildCspSnippet` / `buildInstallGuides` из
 *     `snippet.ts` и шаблону `assist-integrations/gtm/custom-html.html`
 *     для тех же ключа и origin; список директив CSP — `WIDGET_CSP_DIRECTIVES`.
 *  3. JS API в документации = команды `call()` настоящего загрузчика
 *     (`widget/src/loader/index.ts`), события `on` = `EventName`, атрибуты
 *     `data-*` = то, что читает `attrs.ts` (кроме служебного
 *     `data-preview-token` конфигуратора TMA); пример цели = `jsApi.goal`.
 *  4. Пример вебхука из документации, исполненный как есть, даёт подпись,
 *     которую принимает НАСТОЯЩИЙ `verifyGoalWebhook` сервера; формат
 *     совпадает с общими векторами `goal-webhook-vectors.json`; путь —
 *     маршрут контроллера.
 *  5. Хосты публичных платформ на страницах (`*.myshopify.com`, …) — из
 *     списка продукта `PUBLIC_PLATFORM_SUFFIXES` (там только DNS).
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PRODUCT_NAMES, WIDGET_NAMES } from '../src/brand';
import { CSP_DIRECTIVES, EXAMPLE_KEY, cspLines, embedTag, goalCall, gtmHtml, verifyExamples, webhookNodeExample } from '../src/lib/install';
import { loadDoc } from '../src/lib/docs';
import { walkBlocks, inlineText } from '../src/lib/docs-markdown';
import { page } from '../src/lib/pages';
import { PLATFORMS } from '../src/lib/platforms';

const REPO = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const backBrand = read('sites-backend/src/brand.ts');
const constOf = (src: string, name: string) => {
  const m = new RegExp(`export const ${name}\\s*=\\s*\\n?\\s*['"]([^'"]+)['"]`).exec(src);
  assert.ok(m, `нет ${name}`);
  return m[1];
};

// ── 1. Имена ──
const pairs: Array<[string, string]> = [
  ['VERIFY_TXT_PREFIX', PRODUCT_NAMES.verifyTxtPrefix],
  ['VERIFY_TXT_KEY', PRODUCT_NAMES.verifyTxtKey],
  ['VERIFY_FILE_PATH', PRODUCT_NAMES.verifyFilePath],
  ['VERIFY_META_NAME', PRODUCT_NAMES.verifyMetaName],
  ['CRAWLER_ROBOTS_TOKEN', PRODUCT_NAMES.crawlerRobotsToken],
  ['CRAWLER_USER_AGENT', PRODUCT_NAMES.crawlerUserAgent],
  ['SANDBOX_KEY_HEADER', PRODUCT_NAMES.sandboxKeyHeader],
  ['GOAL_WEBHOOK_SIGNATURE_HEADER', PRODUCT_NAMES.webhookSignatureHeader],
  ['WIDGET_NPM_PACKAGE', PRODUCT_NAMES.npmPackage],
  ['WP_PLUGIN_SLUG', PRODUCT_NAMES.wpPluginSlug],
  ['WIDGET_GOAL_ATTR', PRODUCT_NAMES.goalAttr],
  ['WIDGET_GOAL_SUBMIT_ATTR', PRODUCT_NAMES.goalSubmitAttr],
  ['WIDGET_GLOBAL', WIDGET_NAMES.global],
  ['WIDGET_LOADER_PATH', WIDGET_NAMES.loaderPath],
  ['WIDGET_ANCHOR', WIDGET_NAMES.anchor],
];
for (const [name, ours] of pairs) assert.equal(ours, constOf(backBrand, name), `brand.ts лендинга разошёлся с sites-backend: ${name}`);
const npmBrand = read('assist-integrations/npm/src/brand.ts');
assert.equal(constOf(npmBrand, 'WIDGET_NPM_PACKAGE'), PRODUCT_NAMES.npmPackage);
assert.equal(constOf(npmBrand, 'GOAL_WEBHOOK_SIGNATURE_HEADER'), PRODUCT_NAMES.webhookSignatureHeader);
assert.equal(JSON.parse(read('assist-integrations/npm/package.json')).name, PRODUCT_NAMES.npmPackage);
assert.ok(fs.existsSync(path.join(REPO, 'assist-integrations/wordpress', PRODUCT_NAMES.wpPluginSlug, `${PRODUCT_NAMES.wpPluginSlug}.php`)), 'слаг плагина WordPress');
// Страница о боте — та, на которую указывает User-Agent обходчика.
const uaUrl = /\+(https:\/\/[^)\s]+)\)/.exec(PRODUCT_NAMES.crawlerUserAgent)?.[1];
assert.ok(uaUrl, 'в User-Agent нет адреса страницы бота');
assert.equal(new URL(uaUrl).pathname, page('bot').path, 'User-Agent обходчика ведёт не на нашу страницу бота (без локали — middleware уведёт на /<loc>/…)');
// Префикс переноса песочницы — из реестра site-tma-kit.
assert.match(read('site-tma-kit/src/start-param.ts'), new RegExp(`sb: '${PRODUCT_NAMES.sandboxStartPrefix}'`));

async function main() {
  // ── 2. Код вставки, CSP, GTM — вывод настоящего snippet.ts ──
  const snippet = (await import(pathToFileURL(path.join(REPO, 'sites-backend/src/modules/assist-site-setup/snippet.ts')).href)) as {
    buildEmbedSnippet: (o: { publicKey: string; widgetOrigin: string }) => string;
    buildCspSnippet: (origin: string) => string;
    buildInstallGuides: (o: { publicKey: string; widgetOrigin: string }) => { gtm: { html: string }; jsApi: { goal: string }; npm: { install: string } };
    WIDGET_CSP_DIRECTIVES: readonly string[];
  };
  const origins = ['https://w.example.com', 'https://assist-w.viral4creators.app', 'http://localhost:3011'];
  const keys = [EXAMPLE_KEY, 'pk_test_landing00000000000000001', 'pk_live_' + 'Z'.repeat(24)];
  for (const origin of origins) {
    for (const key of keys) {
      assert.equal(embedTag(origin, key), snippet.buildEmbedSnippet({ publicKey: key, widgetOrigin: origin }), `код вставки ${origin} ${key}`);
      assert.equal(gtmHtml(origin, key), snippet.buildInstallGuides({ publicKey: key, widgetOrigin: origin }).gtm.html, `GTM ${origin}`);
      const tpl = read('assist-integrations/gtm/custom-html.html').replace(/<!--[\s\S]*?-->\s*/g, '').trim().replace('{{ORIGIN}}', origin).replace('{{PK}}', key);
      assert.equal(gtmHtml(origin, key), tpl, 'шаблон GTM assist-integrations');
    }
    assert.equal(cspLines(origin), snippet.buildCspSnippet(origin), `CSP ${origin}`);
  }
  assert.deepEqual([...CSP_DIRECTIVES], [...snippet.WIDGET_CSP_DIRECTIVES]);
  const keysMod = (await import(pathToFileURL(path.join(REPO, 'sites-backend/src/modules/assist-site-setup/keys.ts')).href)) as { parsePublicKey: (k: string) => unknown };
  assert.ok(keysMod.parsePublicKey(EXAMPLE_KEY), 'заглушка ключа — не в формате продукта (parsePublicKey)');
  assert.equal(goalCall(), snippet.buildInstallGuides({ publicKey: keys[0], widgetOrigin: origins[0] }).jsApi.goal, 'пример цели');

  // ── 3. JS API и атрибуты — из кода загрузчика ──
  const loader = read('widget/src/loader/index.ts');
  const callBody = /\n {2}call\(args: unknown\[\]\) \{([\s\S]*?)\n {2}\}\n/.exec(loader)?.[1];
  assert.ok(callBody, 'не нашли call() в загрузчике');
  const commands = [...callBody.matchAll(/case '([a-z]+)':/g)].map((m) => m[1]).filter((c) => c !== 'preview').sort();
  const events = (/type EventName = ([^;]+);/.exec(loader)?.[1] ?? '').match(/'([a-z]+)'/g)!.map((s) => s.slice(1, -1)).sort();
  const attrs = [...read('widget/src/loader/attrs.ts').matchAll(/get\('(data-[a-z-]+)'\)/g)].map((m) => m[1]).filter((a) => a !== 'data-preview-token');

  for (const locale of ['uk', 'en'] as const) {
    const env = { widgetOrigin: 'https://w.example.com', apiOrigin: 'https://api.example.com' };
    const api = loadDoc('docs-js-api', locale, { env });
    const install = loadDoc('docs', locale, { env });
    const goals = loadDoc('docs-goals', locale, { env });
    const csp = loadDoc('docs-csp', locale, { env });
    const text = (doc: typeof api) => {
      const parts: string[] = [];
      walkBlocks(doc.blocks, (b) => {
        if (b.kind === 'p' || b.kind === 'note') parts.push(inlineText(b.inline));
        if (b.kind === 'ul' || b.kind === 'ol') parts.push(...b.items.map(inlineText));
        if (b.kind === 'table') parts.push(...b.rows.flat().map(inlineText));
        if (b.kind === 'code') parts.push(b.code);
      });
      return parts.join('\n');
    };
    const spans = (doc: typeof api) => {
      const out = new Set<string>();
      const add = (inl: readonly { kind: string; text: string }[]) => inl.forEach((x) => x.kind === 'code' && out.add(x.text));
      walkBlocks(doc.blocks, (b) => {
        if (b.kind === 'p' || b.kind === 'note') add(b.inline);
        if (b.kind === 'ul' || b.kind === 'ol') b.items.forEach(add);
        if (b.kind === 'table') b.rows.flat().forEach(add);
      });
      return out;
    };
    // Команды — из первого столбца таблицы команд: `V4CAssist('open')`, `('close')`.
    const firstCells: string[] = [];
    walkBlocks(api.blocks, (b) => {
      if (b.kind === 'table') firstCells.push(...b.rows.map((r) => inlineText(r[0])));
    });
    const documented = [...firstCells.join(' ').matchAll(/\('([a-z]+)'/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(documented)].sort(), commands, `JS API (${locale}): документировано ≠ команды загрузчика`);
    for (const e of events) assert.ok(spans(api).has(e), `событие on('${e}') не описано (${locale})`);
    const installText = text(install);
    for (const a of attrs) assert.ok(spans(install).has(a), `атрибут ${a} не описан (${locale})`);
    const documentedAttrs = [...spans(install)].filter((a) => /^data-[a-z-]+$/.test(a));
    for (const a of documentedAttrs) assert.ok(attrs.includes(a), `атрибута ${a} загрузчик не читает (${locale})`);
    // Код вставки и CSP в документации — ровно вывод продукта для того же origin.
    assert.ok(installText.includes(snippet.buildEmbedSnippet({ publicKey: EXAMPLE_KEY, widgetOrigin: env.widgetOrigin })), `в установке нет кода вставки продукта (${locale})`);
    assert.ok(text(csp).includes(snippet.buildCspSnippet(env.widgetOrigin)), `в CSP нет директив продукта (${locale})`);
    const v = verifyExamples();
    for (const s of [v.dnsName, v.dnsValue, v.fileUrl, v.meta]) assert.ok(installText.includes(s), `подтверждение «${s}» (${locale})`);
    for (const d of snippet.WIDGET_CSP_DIRECTIVES) assert.ok(spans(csp).has(d), `директива ${d} не пояснена (${locale})`);
    const goalsText = text(goals);
    assert.ok(goalsText.includes(PRODUCT_NAMES.webhookSignatureHeader) && goalsText.includes('t=<unix>,v1='), `формат подписи (${locale})`);
    assert.ok(goalsText.includes('Idempotency-Key'), `Idempotency-Key (${locale})`);
  }

  // ── 4. Пример вебхука исполняется и проходит НАСТОЯЩУЮ проверку сервера ──
  const sig = (await import(pathToFileURL(path.join(REPO, 'sites-backend/src/modules/assist-analytics/webhook-signature.ts')).href)) as {
    verifyGoalWebhook: (secret: string, raw: string, header: string | undefined, now: number) => string;
    signGoalWebhook: (secret: string, raw: string, t: number) => string;
  };
  const vectors = JSON.parse(read('assist-integrations/fixtures/goal-webhook-vectors.json')) as { webhook: Array<{ secret: string; body: string; t: number; header: string }> };
  for (const v of vectors.webhook) {
    // Тот же расчёт, что в примере документации: HMAC-SHA256(secret, `${t}.${body}`) → hex.
    const v1 = createHmac('sha256', v.secret).update(`${v.t}.${v.body}`, 'utf8').digest('hex');
    assert.equal(`t=${v.t},v1=${v1}`, v.header, 'формат подписи из документации ≠ общие векторы');
    assert.equal(sig.verifyGoalWebhook(v.secret, v.body, v.header, v.t + 60), 'ok');
  }
  {
    const code = webhookNodeExample('https://api.example.com/assist/v1/sites/SITE_ID/goal-events');
    const sent: Array<{ url: string; init: { headers: Record<string, string>; body: string } }> = [];
    const run = new Function('createHmac', 'process', 'fetch', `return (async () => {\n${code.replace(/^import .*$/m, '')}\n})();`);
    const secret = 'whsec_docs_example_secret';
    await run(createHmac, { env: { ASSIST_GOAL_WEBHOOK_SECRET: secret } }, async (url: string, init: { headers: Record<string, string>; body: string }) => {
      sent.push({ url, init });
      return { ok: true };
    });
    assert.equal(sent.length, 1);
    const header = sent[0].init.headers[PRODUCT_NAMES.webhookSignatureHeader];
    const now = Math.floor(Date.now() / 1000);
    assert.equal(sig.verifyGoalWebhook(secret, sent[0].init.body, header, now), 'ok', 'сервер отверг подпись из примера документации');
    assert.equal(sig.verifyGoalWebhook(secret, sent[0].init.body + ' ', header, now), 'mismatch', 'подпись не по байтам тела');
    assert.equal(sent[0].init.headers['Idempotency-Key'], JSON.parse(sent[0].init.body).orderId);
    const ctrl = read('sites-backend/src/modules/assist-analytics/goal-webhook.controller.ts');
    assert.match(ctrl, /@Controller\('assist\/v1\/sites'\)/);
    assert.match(ctrl, /@Post\(':id\/goal-events'\)/);
    assert.ok(new URL(sent[0].url).pathname.startsWith('/assist/v1/sites/') && sent[0].url.endsWith('/goal-events'));
    // Тело примера — по правилам серверного разбора (`parseWebhookEvent`: белый
    // список полей, статусы, ISO-дата). Сервис с декораторами Nest tsx не
    // импортирует — правила берём из текста исходника.
    const svcSrc = read('sites-backend/src/modules/assist-analytics/goal-webhook.service.ts');
    const listOf = (name: string) => /const NAME = \[([\s\S]*?)\]/.source.replace('NAME', name);
    const bodyKeys = new RegExp(listOf('BODY_KEYS')).exec(svcSrc)![1].match(/'([^']+)'/g)!.map((x) => x.slice(1, -1));
    const statuses = new RegExp(listOf('STATUSES')).exec(svcSrc)![1].match(/'([^']+)'/g)!.map((x) => x.slice(1, -1));
    const iso = new RegExp(/const ISO =\s*\/(.+)\/;/.exec(svcSrc)![1]);
    const body = JSON.parse(sent[0].init.body) as Record<string, unknown>;
    for (const k of Object.keys(body)) assert.ok(bodyKeys.includes(k), `поле ${k} сервер не принимает`);
    assert.ok(statuses.includes(body.status as string), `статус ${body.status}`);
    assert.match(body.occurredAt as string, iso, 'occurredAt не ISO по правилу сервера');
  }

  // ── 5. Хосты публичных платформ ──
  const hostsSrc = read('sites-backend/src/modules/site-core/hosts/host-normalize.ts');
  const suffixes = /PUBLIC_PLATFORM_SUFFIXES = \[([\s\S]*?)\]/.exec(hostsSrc)![1].match(/'([^']+)'/g)!.map((s) => s.slice(1, -1));
  for (const p of PLATFORMS) {
    if ('publicSuffix' in p && p.publicSuffix) assert.ok(suffixes.includes(p.publicSuffix), `${p.slug}: ${p.publicSuffix} нет в PUBLIC_PLATFORM_SUFFIXES`);
  }
  for (const s of ['myshopify.com', 'tilda.ws']) assert.ok(suffixes.includes(s), `в продукте ${s} больше не «только DNS» — поправьте страницы платформ`);

  console.log(
    `ok   документация ↔ продукт: ${pairs.length} публичных имён = sites-backend (+ npm/WordPress), страница бота = адрес в User-Agent; код вставки, GTM и CSP = snippet.ts на ${origins.length * keys.length} парах; JS API = ${commands.length} команд загрузчика, ${events.length} событий, ${attrs.length} атрибутов data-*; пример вебхука проходит verifyGoalWebhook сервера и общие векторы; хосты платформ — из PUBLIC_PLATFORM_SUFFIXES`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
