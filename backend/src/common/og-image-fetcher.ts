/**
 * og-image-fetcher.ts — добыча og:image (или любой другой пригодной
 * картинки) со страницы по её URL, портировано из Solar Shop
 * (`apps/api/src/common/og-image-fetcher.ts`).
 *
 * Три уровня, от дешёвого к дорогому:
 *   1. Лёгкий `fetch()` с реалистичными браузерными заголовками —
 *      достаточно для подавляющего большинства сайтов.
 *   2. Если лёгкий запрос упёрся в бот-защиту (403/429, JS-челлендж
 *      Cloudflare/Akamai/Incapsula) — поднимаем headless Chromium через
 *      `./headless-chromium` (`launchHeadlessBrowser()`), даём странице
 *      прогрузиться и докрутить lazy-load, собираем кандидатов уже из
 *      живого DOM.
 *   3. Из собранных кандидатов (og:image → twitter:image → JSON-LD →
 *      первый подходящий `<img>`) берём первый, который реально
 *      открывается (HEAD-подобная Range-проверка).
 *
 * Само поднятие браузера — в `./headless-chromium.ts`, отдельном общем
 * модуле (см. его шапку): здесь используется только его
 * `launchHeadlessBrowser()`/`withTimeout()`, никакой логики запуска
 * Chromium в этом файле больше нет.
 *
 * Используется в двух местах: `blog-cover-image.ts` — запасной путь,
 * когда у кандидата на пост нет `thumbnailUrl` вовсе (см. этап 95),
 * и потенциально — там же, где полезна любая другая og:image-добыча.
 */

import { fetchWithRetry } from './fetch-with-retry';
import { launchHeadlessBrowser, withTimeout } from './headless-chromium';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.7',
};

export async function fetchOgImage(
  pageUrl: string,
): Promise<{ imageUrl: string | null; diagnostic: string }> {
  const lightResult = await fetchOgImageLight(pageUrl);
  if (lightResult.imageUrl || !lightResult.needsHeadlessBrowser) {
    return {
      imageUrl: lightResult.imageUrl,
      diagnostic: lightResult.diagnostic,
    };
  }

  console.log(
    `[og-image-fetcher] ${pageUrl}: лёгкий fetch упёрся в бот-защиту (${lightResult.diagnostic}) — пробую headless-браузер...`,
  );
  const browserResult = await fetchOgImageWithBrowser(pageUrl);
  console.log(
    `[og-image-fetcher] ${pageUrl}: headless-браузер → ${browserResult.diagnostic}`,
  );
  return browserResult;
}

async function fetchOgImageLight(pageUrl: string): Promise<{
  imageUrl: string | null;
  diagnostic: string;
  needsHeadlessBrowser: boolean;
}> {
  try {
    const res = await fetchWithRetry(pageUrl, {
      retries: 1,
      timeoutMs: 8_000,
      headers: BROWSER_HEADERS,
    });
    if (!res.ok) {
      // 403/429 — классические признаки простой бот-блокировки (по
      // User-Agent/заголовкам), а не «страницы не существует» (как
      // 404) — именно ради такого класса случаев и существует
      // headless-браузер. Остальные статусы (404, 500 и т.п.) без
      // эскалации — реальное отсутствие/ошибка страницы браузером не
      // починится.
      const isBotBlockStatus = res.status === 403 || res.status === 429;
      return {
        imageUrl: null,
        diagnostic: `HTTP ${res.status}`,
        needsHeadlessBrowser: isBotBlockStatus,
      };
    }
    const html = await res.text();

    const looksLikeJsChallenge =
      /checking your browser|cf-browser-verification|challenge-platform|__cf_chl_|akamai|_incapsula_|incapsula/i.test(
        html,
      ) && html.length < 5000;
    if (looksLikeJsChallenge) {
      return {
        imageUrl: null,
        diagnostic: `HTML ${html.length}б — JS-челлендж (Cloudflare/Akamai/Incapsula)`,
        needsHeadlessBrowser: true,
      };
    }

    if (html.length < 1000) {
      return {
        imageUrl: null,
        diagnostic: `HTML лишь ${html.length}б (подозрительно мало), финальный URL: ${res.url} — содержимое: ${JSON.stringify(html.slice(0, 300))}`,
        needsHeadlessBrowser: true,
      };
    }

    const candidates = extractImageCandidates(html);
    if (candidates.length === 0) {
      return {
        imageUrl: null,
        diagnostic: `HTML ${html.length}б получен, ни один из селекторов не сработал`,
        needsHeadlessBrowser: false,
      };
    }

    const picked = await firstUsableImage(candidates, pageUrl);
    // Кандидаты были, но все битые — это уже не повод поднимать
    // браузер: разметку мы прочитали успешно, проблема в самих файлах.
    return {
      imageUrl: picked.imageUrl,
      diagnostic: picked.diagnostic,
      needsHeadlessBrowser: false,
    };
  } catch (err) {
    // undici прячет настоящую причину сетевой ошибки за общей обёрткой
    // `fetch failed` — разворачиваем цепочку `cause`/`errors` через
    // describeFetchError(). Не эскалируем на headless-браузер только
    // там, где он точно не поможет: имя не резолвится (браузер пойдёт
    // к тому же DNS).
    const detail = describeFetchError(err);
    const hopelessDns = /ENOTFOUND|EAI_AGAIN/i.test(detail);
    return {
      imageUrl: null,
      diagnostic: `запрос провалился: ${detail}`,
      needsHeadlessBrowser: !hopelessDns,
    };
  }
}

// undici прячет настоящую причину в цепочке `cause`, иногда на два
// уровня вглубь (`fetch failed` → `AggregateError` → `Error:
// certificate has expired`). Разворачиваем всю цепочку, а не только
// верхнее сообщение.
function describeFetchError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth++) {
    if (current instanceof Error) {
      const code = (current as NodeJS.ErrnoException).code;
      parts.push(code ? `${current.message} (${code})` : current.message);
      // AggregateError (напр. когда перебираются все адреса хоста)
      // хранит отдельные причины в `errors`, не в `cause`.
      const aggregated = (current as AggregateError).errors;
      if (Array.isArray(aggregated) && aggregated.length > 0) {
        current = aggregated[0];
        continue;
      }
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  // Дедупликация: undici нередко повторяет тот же текст на двух уровнях.
  return [...new Set(parts)].join(' ← ') || 'неизвестная ошибка';
}

// ---- Функции, выполняемые в контексте САМОЙ СТРАНИЦЫ ----
//
// Эти две функции сериализуются и выполняются в браузере через
// `page.evaluate()`, поэтому всё, чем они пользуются, должно быть
// внутри них: никаких импортов, констант или типов из этого модуля
// здесь не видно.

// Прокрутка вниз шагами, чтобы сработал lazy-load. Ограничена и по
// высоте, и по числу шагов: на бесконечных лентах иначе можно крутить
// вечно.
function scrollThroughPage(): Promise<void> {
  return new Promise<void>((resolve) => {
    let scrolled = 0;
    let steps = 0;
    const step = () => {
      window.scrollBy(0, window.innerHeight);
      scrolled += window.innerHeight;
      steps++;
      if (
        steps >= 12 ||
        scrolled >= document.body.scrollHeight ||
        scrolled > 12000
      ) {
        window.scrollTo(0, 0);
        return resolve();
      }
      setTimeout(step, 120);
    };
    step();
  });
}

// Сбор кандидатов из живого DOM, в порядке надёжности.
function collectImageCandidates(): string[] {
  const out: string[] = [];
  const add = (value: string | null | undefined) => {
    if (!value) return;
    if (value.startsWith('data:')) return;
    try {
      const absolute = new URL(value, document.baseURI).toString();
      if (!out.includes(absolute)) out.push(absolute);
    } catch {
      /* не URL — пропускаем */
    }
  };

  // 1. Метаданные: то, что сайт сам назначил для соцсетей.
  for (const selector of [
    'meta[property="og:image"]',
    'meta[property="og:image:secure_url"]',
    'meta[name="twitter:image"]',
    'meta[name="twitter:image:src"]',
    'meta[itemprop="image"]',
  ]) {
    add(document.querySelector(selector)?.getAttribute('content'));
  }
  add(document.querySelector('link[rel="image_src"]')?.getAttribute('href'));

  // 2. Реально загруженные картинки — по настоящему размеру, большие
  //    впереди. naturalWidth знает только браузер.
  const loaded = Array.from(document.images)
    .filter(
      (img) =>
        img.currentSrc && img.naturalWidth >= 200 && img.naturalHeight >= 200,
    )
    .filter(
      (img) =>
        !/logo|icon|favicon|sprite|avatar|placeholder/i.test(img.currentSrc),
    )
    .sort(
      (a, b) =>
        b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight,
    );
  for (const img of loaded) add(img.currentSrc);

  // 3. Ленивые картинки, которые так и не загрузились: берём то, что
  //    сайт приготовил в атрибутах.
  for (const img of Array.from(document.querySelectorAll('img'))) {
    for (const attr of [
      'data-src',
      'data-original',
      'data-lazy-src',
      'data-echo',
    ]) {
      const value = img.getAttribute(attr);
      if (value && !/logo|icon|favicon|sprite|avatar|placeholder/i.test(value))
        add(value);
    }
  }

  return out;
}

async function fetchOgImageWithBrowser(
  pageUrl: string,
): Promise<{ imageUrl: string | null; diagnostic: string }> {
  const launched = await launchHeadlessBrowser();
  if ('error' in launched) {
    return { imageUrl: null, diagnostic: launched.error };
  }
  const { browser } = launched;

  try {
    const page = await browser.newPage();
    await page.setUserAgent(BROWSER_HEADERS['User-Agent']);
    await page.setExtraHTTPHeaders({
      'Accept-Language': BROWSER_HEADERS['Accept-Language'],
    });

    // Явный общий timeout на ВЕСЬ вызов (не только page.goto()) —
    // некоторые SPA-сайты никогда не достигают networkidle2
    // (постоянные фоновые запросы). withTimeout гарантирует, что
    // зависшая страница не держит ресурсы (и сам процесс Chromium)
    // бесконечно долго.
    await withTimeout(
      page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 20_000 }),
      25_000,
      'Общий timeout headless-браузера (25с)',
    );
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    // Прокручиваем страницу перед тем, как что-то с неё брать: многие
    // современные CMS грузят иллюстрации лениво (data-src вместо src
    // до попадания во вьюпорт) — без прокрутки в DOM их просто нет.
    await page.evaluate(scrollThroughPage).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    // Спрашиваем саму страницу, а не регулярки по HTML: у нас в руках
    // настоящий браузер, он знает, какие картинки РЕАЛЬНО загрузились
    // и какого они на самом деле размера (naturalWidth).
    const domCandidates = (await page
      .evaluate(collectImageCandidates)
      .catch(() => [])) as string[];

    // HTML-разбор остаётся вторым эшелоном: он видит то, до чего DOM
    // не дошёл (data-src у картинок, которые так и не загрузились).
    const html = await page.content();
    const candidates = [
      ...new Set([...domCandidates, ...extractImageCandidates(html)]),
    ].slice(0, MAX_IMAGE_CANDIDATES);
    if (candidates.length === 0) {
      return {
        imageUrl: null,
        diagnostic: `headless: HTML ${html.length}б получен, ни один из селекторов не сработал (возможно, челлендж не пройден даже так)`,
      };
    }

    const picked = await firstUsableImage(candidates, pageUrl);
    return {
      imageUrl: picked.imageUrl,
      diagnostic: picked.imageUrl
        ? `${picked.diagnostic} — через headless-браузер`
        : `headless: ${picked.diagnostic}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Самая частая причина падения на Vercel — нехватка памяти
    // функции: Chromium просит от ~512 МБ, а дефолт делится ещё и с
    // Nest и Prisma. Поэтому подсказка идёт прямо в диагностику.
    return {
      imageUrl: null,
      diagnostic: `headless-браузер провалился: ${message}${
        /spawn|ENOENT|killed|out of memory|SIGKILL/i.test(message)
          ? ' — похоже на нехватку памяти или отсутствующий бинарник; проверьте лимит памяти функции на Vercel'
          : ''
      }`,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function extractImageCandidates(html: string): string[] {
  const found: string[] = [];
  const add = (v: string | null | undefined) => {
    if (v && !found.includes(v)) found.push(v);
  };

  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:image:src["'][^>]+content=["']([^"']+)["']/i,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,
    /<meta[^>]+itemprop=["']image["'][^>]+content=["']([^"']+)["']/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    add(match?.[1]);
  }

  const jsonLdBlocks =
    html.match(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ) ?? [];
  for (const block of jsonLdBlocks) {
    const inner = block.replace(/<script[^>]*>|<\/script>/gi, '');
    try {
      const data = JSON.parse(inner) as Record<string, unknown>;
      const image = data.image;
      if (typeof image === 'string') add(image);
      else if (Array.isArray(image) && typeof image[0] === 'string')
        add(image[0]);
      else if (
        image &&
        typeof image === 'object' &&
        'url' in image &&
        typeof (image as { url: unknown }).url === 'string'
      ) {
        add((image as { url: string }).url);
      }
    } catch {
      continue;
    }
  }

  // Резервный уровень — первый правдоподобный <img>, с фильтрацией
  // явных иконок/логотипов (по имени файла или по явно заданным малым
  // размерам в атрибутах width/height).
  const imgTags = html.match(/<img\b[^>]*>/gi) ?? [];
  for (const tag of imgTags) {
    // Ленивые атрибуты ПЕРЕД `src`, не наоборот: когда есть оба, `src`
    // нередко — прозрачная заглушка 1×1, а настоящая картинка лежит в
    // data-src.
    const lazyMatch =
      tag.match(/\bdata-src=["']([^"']+)["']/i) ??
      tag.match(/\bdata-original=["']([^"']+)["']/i) ??
      tag.match(/\bdata-lazy-src=["']([^"']+)["']/i);
    // srcset: берём самый первый URL из списка "url 320w, url 640w".
    const srcsetMatch = tag.match(/\b(?:data-)?srcset=["']([^"']+)["']/i);
    const src =
      lazyMatch?.[1] ??
      srcsetMatch?.[1]?.split(',')[0]?.trim().split(/\s+/)[0] ??
      tag.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    if (!src) continue;

    if (/logo|icon|favicon|sprite|avatar|placeholder/i.test(src)) continue;

    const widthMatch = tag.match(/\bwidth=["']?(\d+)/i);
    const heightMatch = tag.match(/\bheight=["']?(\d+)/i);
    const width = widthMatch ? Number(widthMatch[1]) : undefined;
    const height = heightMatch ? Number(heightMatch[1]) : undefined;
    if ((width && width < 100) || (height && height < 100)) continue;

    if (src.startsWith('data:')) continue; // inline base64 — не настоящая картинка для загрузки

    add(src);
    // Нескольких крупных картинок со страницы достаточно; дальше пошли
    // бы баннеры-соседи, а каждый кандидат стоит отдельной проверки.
    if (found.length >= MAX_IMAGE_CANDIDATES) break;
  }

  return found.slice(0, MAX_IMAGE_CANDIDATES);
}

// Кандидаты собираются списком в порядке надёжности (og:image →
// twitter:image → JSON-LD → первый крупный <img>), и берём ПЕРВЫЙ,
// который реально открывается.
const MAX_IMAGE_CANDIDATES = 4;

// Проверка намеренно мягкая: отбрасываем только то, что ТОЧНО сломано —
// сетевая ошибка, 404/410, или HTML вместо картинки (типичный «мягкий
// 404», когда сервер отдаёт страницу ошибки со статусом 200). 403 не
// отбрасываем: это часто защита от хотлинка по Referer, и в браузере
// пользователя такая картинка откроется нормально. Лучше сохранить
// сомнительный URL, чем отбросить рабочий.
async function imageUrlUsable(
  imageUrl: string,
): Promise<{ ok: boolean; reason: string }> {
  try {
    // Range 0-0 — качаем один байт, а не весь файл: нужны лишь статус и
    // content-type.
    const res = await fetchWithRetry(imageUrl, {
      retries: 0,
      timeoutMs: 8_000,
      headers: { ...BROWSER_HEADERS, Range: 'bytes=0-0' },
    });
    if (res.status === 404 || res.status === 410)
      return { ok: false, reason: `HTTP ${res.status}` };
    const contentType = res.headers.get('content-type') ?? '';
    if (/^\s*text\//i.test(contentType))
      return {
        ok: false,
        reason: `content-type ${contentType} — это страница, не картинка`,
      };

    // Полный размер файла. При Range-запросе content-length равен 1,
    // поэтому настоящий размер берём из content-range ("bytes 0-0/43").
    const totalBytes = Number(
      res.headers.get('content-range')?.split('/')[1] ??
        res.headers.get('content-length') ??
        NaN,
    );
    // Прозрачные заглушки lazy-load — это GIF 1×1 на 43 байта. Ни одна
    // реальная иллюстрация не весит меньше килобайта, поэтому порог
    // отсекает именно заглушки и ничего полезного.
    if (Number.isFinite(totalBytes) && totalBytes > 0 && totalBytes < 1024) {
      return {
        ok: false,
        reason: `лишь ${totalBytes} байт — это заглушка, не иллюстрация`,
      };
    }

    return {
      ok: true,
      reason: `HTTP ${res.status}${contentType ? `, ${contentType}` : ''}`,
    };
  } catch (err) {
    return { ok: false, reason: describeFetchError(err) };
  }
}

// Превращает кандидатов в абсолютные URL и возвращает первый рабочий.
async function firstUsableImage(
  candidates: string[],
  pageUrl: string,
): Promise<{ imageUrl: string | null; diagnostic: string }> {
  const rejected: string[] = [];
  for (const raw of candidates) {
    let absolute: string;
    try {
      absolute = new URL(raw, pageUrl).toString();
    } catch {
      if (!raw.startsWith('http')) {
        rejected.push(`"${raw}" — не удалось превратить в абсолютный URL`);
        continue;
      }
      absolute = raw;
    }
    const check = await imageUrlUsable(absolute);
    if (check.ok)
      return { imageUrl: absolute, diagnostic: `OK (${check.reason})` };
    rejected.push(`${absolute} — ${check.reason}`);
  }
  return {
    imageUrl: null,
    diagnostic:
      rejected.length > 0
        ? `ни один кандидат не открылся: ${rejected.join('; ')}`
        : 'кандидатов не найдено',
  };
}
