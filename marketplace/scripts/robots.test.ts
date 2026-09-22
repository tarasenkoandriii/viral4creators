/**
 * `/robots.txt` маркетплейса — три утверждения, каждое из которых
 * ломается молча.
 *
 * Появился вместе с самим `app/robots.ts` (до него маршрут отвечал
 * 404). Проверять тут нечего «вычислительно» — функция возвращает
 * литерал; ценность теста в другом: все три ошибки, от которых он
 * страхует, НЕ ВИДНЫ ни на странице, ни в сборке, ни в логах. Сайт
 * продолжает работать, а карта сайта просто перестаёт находиться —
 * и узнают об этом через месяцы по трафику.
 *
 * Проверено «обратным ходом» на трёх поломках `robots.ts`: убран
 * `sitemap-news.xml`, убран `/embed/`, проигнорирована переменная
 * окружения (остался дефолт `localhost`). Каждая ловится. С оговоркой:
 * третью ловит ПЕРВАЯ проверка — она сравнивает адреса карт целиком,
 * и подменённый хост виден уже в ней. Отдельная проверка на localhost
 * оставлена не ради этой поломки, а на будущее: в `robots.txt` со
 * временем добавляют поля (`host`, отдельные правила для ботов), и
 * дефолт может просочиться туда, куда первая проверка не смотрит.
 *
 * Запуск: `npm test` в marketplace.
 */

import assert from 'node:assert/strict';

let passed = 0;
function it(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

const SITE = 'https://market.viral4creators.app';
process.env.NEXT_PUBLIC_SITE_URL = SITE;

// Импорт модуля отложен внутрь async-обёртки намеренно: `robots.ts`
// читает NEXT_PUBLIC_SITE_URL один раз, на загрузке, поэтому
// переменная должна быть выставлена ДО импорта. Обёртка, а не
// top-level await, потому что tsx собирает скрипты этой папки в CJS.
async function main(): Promise<void> {
  const robots = (await import('../src/app/robots')).default;
  const result = robots();

  console.log('robots.txt');

  it('объявляет обе карты сайта, включая новостную', () => {
    const sitemaps = Array.isArray(result.sitemap) ? result.sitemap : [result.sitemap];
    assert.deepEqual(sitemaps, [`${SITE}/sitemap.xml`, `${SITE}/sitemap-news.xml`]);
  });

  it('закрывает /embed/ — виджет не должен попадать в индекс дублем', () => {
    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];
    const disallow = rules.flatMap((r) =>
      r.disallow === undefined ? [] : Array.isArray(r.disallow) ? r.disallow : [r.disallow],
    );
    assert.ok(
      disallow.includes('/embed/'),
      `ожидалось, что /embed/ закрыт, а disallow = ${JSON.stringify(disallow)}`,
    );
  });

  it('не печатает localhost в боевой конфигурации', () => {
    assert.ok(
      !JSON.stringify(result).includes('localhost'),
      'дефолт http://localhost:3004 просочился в robots.txt',
    );
  });

  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
