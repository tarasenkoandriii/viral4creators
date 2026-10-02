/**
 * Код установки для документации и страниц платформ (Л5) — ЧИСТЫЕ функции.
 *
 * Источник правды — продукт: `sites-backend/src/modules/assist-site-setup/
 * snippet.ts` (`buildEmbedSnippet`, `buildCspSnippet`, `buildInstallGuides`)
 * и шаблон `assist-integrations/gtm/custom-html.html`. Здесь — копия
 * формата (код бэкенда в сборку лендинга не тянем); что строки побайтно
 * совпадают с выводом продукта для тех же ключа и origin, держит
 * `scripts/integrations.test.ts`. Публичные имена — только из `brand.ts`.
 *
 * Ключ сайта в примерах — заглушка `pk_live_…` (настоящий выдаёт TMA после
 * подтверждения хоста); origin виджета — из сборки (`ASSIST_WIDGET_ORIGIN`).
 */
import { PRODUCT_NAMES, WIDGET_NAMES } from '../brand';

/**
 * Ключ-заглушка в примерах — в формате продукта (`pk_live_` + 24 латинских
 * буквы/цифры, `parsePublicKey`), чтобы пример не отвергал загрузчик; по
 * тексту видно, что это не настоящий ключ.
 */
export const EXAMPLE_KEY = 'pk_live_YourSiteKeyFromCabinet00';

function attr(v: string): string {
  return v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** `<script async src="<origin><путь загрузчика>" data-site="pk_live_…"></script>` — как `buildEmbedSnippet`. */
export function embedTag(widgetOrigin: string, key: string = EXAMPLE_KEY): string {
  return `<script async src="${attr(`${widgetOrigin}${WIDGET_NAMES.loaderPath}`)}" data-site="${attr(key)}"></script>`;
}

/** Директивы CSP — в порядке инструкции продукта (`WIDGET_CSP_DIRECTIVES`). */
export const CSP_DIRECTIVES = ['script-src', 'frame-src', 'img-src', 'connect-src'] as const;

/** Строки CSP — как `buildCspSnippet`: владелец ДОБАВЛЯЕТ источник к своим директивам. */
export function cspLines(widgetOrigin: string): string {
  return CSP_DIRECTIVES.map((d) => (d === 'img-src' ? `${d} ${widgetOrigin} data:;` : `${d} ${widgetOrigin};`)).join('\n');
}

/** Google Tag Manager → «Пользовательский HTML»: тот же тег (`buildInstallGuides().gtm.html`). */
export function gtmHtml(widgetOrigin: string, key: string = EXAMPLE_KEY): string {
  return embedTag(widgetOrigin, key);
}

/**
 * WordPress без плагина: тег в `<head>` через хук темы. `esc_url`/`esc_attr`
 * — на случай, если человек вставит в строки что-то своё.
 */
export function wordpressHook(widgetOrigin: string, key: string = EXAMPLE_KEY): string {
  return [
    `// functions.php дочірньої теми / child theme`,
    `add_action('wp_head', function () {`,
    `  printf(`,
    `    '<script async src="%s" data-site="%s"></script>' . "\\n",`,
    `    esc_url('${widgetOrigin}${WIDGET_NAMES.loaderPath}'),`,
    `    esc_attr('${key}')`,
    `  );`,
    `});`,
  ].join('\n');
}

/** Next.js (App Router): тег загрузчика через `next/script` — без npm-пакета. */
export function nextScript(widgetOrigin: string, key: string = EXAMPLE_KEY): string {
  return [
    `// app/layout.tsx`,
    `import Script from 'next/script';`,
    ``,
    `export default function RootLayout({ children }: { children: React.ReactNode }) {`,
    `  return (`,
    `    <html lang="uk">`,
    `      <body>`,
    `        {children}`,
    `        <Script src="${widgetOrigin}${WIDGET_NAMES.loaderPath}" data-site="${key}" strategy="afterInteractive" />`,
    `      </body>`,
    `    </html>`,
    `  );`,
    `}`,
  ].join('\n');
}

/** React/Vue без Next: тег один раз при старте приложения (до npm-пакета). */
export function spaInject(widgetOrigin: string, key: string = EXAMPLE_KEY): string {
  return [
    `// main.ts / index.tsx — один раз при старте`,
    `const s = document.createElement('script');`,
    `s.async = true;`,
    `s.src = '${widgetOrigin}${WIDGET_NAMES.loaderPath}';`,
    `s.setAttribute('data-site', '${key}');`,
    `document.head.appendChild(s);`,
  ].join('\n');
}

/** Подтверждение владения: три способа — формат QA-ТЗ §2.4 (общий с помощником). */
export function verifyExamples(host = 'shop.example.com', token = 'TOKEN_FROM_TMA') {
  return {
    dnsName: `${PRODUCT_NAMES.verifyTxtPrefix}.${host}`,
    dnsValue: `${PRODUCT_NAMES.verifyTxtKey}=${token}`,
    fileUrl: `https://${host}${PRODUCT_NAMES.verifyFilePath}`,
    meta: `<meta name="${PRODUCT_NAMES.verifyMetaName}" content="${token}">`,
  };
}

/** robots.txt: запретить наш обходчик целиком. */
export function robotsBlock(): string {
  return `User-agent: ${PRODUCT_NAMES.crawlerRobotsToken}\nDisallow: /`;
}

/** Цель из JS страницы «спасибо» — как `buildInstallGuides().jsApi.goal`. */
export function goalCall(): string {
  return `${WIDGET_NAMES.global}('goal', 'purchase', { value: 1299, currency: 'UAH', orderId: 'A-1042' });`;
}

/** Разметка цели без JS. */
export function goalMarkup(): string {
  return [
    `<a href="/checkout" ${PRODUCT_NAMES.goalAttr}="checkout">Оформити замовлення</a>`,
    `<form action="/lead" ${PRODUCT_NAMES.goalSubmitAttr}="lead">…</form>`,
  ].join('\n');
}

/**
 * Подпись вебхука целей на Node без зависимостей — тот же формат, что
 * проверяет сервер (`verifyGoalWebhook`, окно ±5 мин) и что подписывает
 * npm-пакет (`goalWebhookRequest`): `t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<тело>")>`.
 * Тело сериализуется ОДИН раз — подпись и отправка видят одни байты.
 */
export function webhookNodeExample(endpoint = 'https://API/assist/v1/sites/SITE_ID/goal-events'): string {
  return [
    `import { createHmac } from 'node:crypto';`,
    ``,
    `const secret = process.env.ASSIST_GOAL_WEBHOOK_SECRET; // з TMA → «Інтеграції»`,
    `const body = JSON.stringify({`,
    `  goalKey: 'purchase',`,
    `  orderId: 'A-1042',`,
    `  value: 1299,`,
    `  currency: 'UAH',`,
    `  status: 'completed', // або 'refunded' | 'cancelled'`,
    `  occurredAt: new Date().toISOString(),`,
    `});`,
    `const t = Math.floor(Date.now() / 1000);`,
    `const v1 = createHmac('sha256', secret).update(\`\${t}.\${body}\`, 'utf8').digest('hex');`,
    ``,
    `await fetch('${endpoint}', {`,
    `  method: 'POST',`,
    `  headers: {`,
    `    'Content-Type': 'application/json',`,
    `    '${PRODUCT_NAMES.webhookSignatureHeader}': \`t=\${t},v1=\${v1}\`,`,
    `    'Idempotency-Key': 'A-1042',`,
    `  },`,
    `  body,`,
    `});`,
  ].join('\n');
}

/** Значение заголовка подписи (для проверки примера тестом на общих векторах). */
export const SIGNATURE_FORMAT = 't=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>';
