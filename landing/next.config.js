/**
 * Поддомен поздравлений (docs-tz/AUDIT-Greeting-Landing-And-Upgrade-Plan.md,
 * находка 1.6). `greeting.viral4creators.app` уже подключён к этому же
 * проекту Vercel, но своей страницы у него пока нет — этап 3 плана ещё
 * не сделан, и до тех пор поддомен отдаёт тот же главный лендинг, что и
 * `welcome.viral4creators.app`.
 *
 * Два одинаковых HTML на двух адресах без `canonical` — дубль контента,
 * причём худшего сорта: страницы конкурируют друг с другом в выдаче за
 * те же запросы. Пока у поддомена нет собственного содержимого, самый
 * честный ответ поисковику — «меня пока не индексируй».
 *
 * Заголовком в `headers()`, а не в `middleware.ts`, по двум причинам:
 * middleware этого проекта намеренно не запускается на `/legal`,
 * `/feed`, `/video` и всей статике (см. его `matcher`), а дубль
 * касается всех этих путей одинаково; и `X-Robots-Tag` — это ровно
 * заголовок ответа, а не логика маршрутизации.
 *
 * Снимается на этапе 3 вместе с появлением `/[locale]/greetings`: тогда
 * поддомен получает собственное содержимое, `canonical` на себя и место
 * в собственном sitemap.
 */
const GREETING_HOST =
  process.env.NEXT_PUBLIC_GREETING_HOST ?? 'greeting.viral4creators.app';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/:path*',
        has: [{ type: 'host', value: GREETING_HOST }],
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
