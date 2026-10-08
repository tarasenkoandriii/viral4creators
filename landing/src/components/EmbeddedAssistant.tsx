'use client';

import { Suspense, lazy, type ComponentProps, type ComponentType } from 'react';
import type { AssistantWidget } from './AssistantWidget';

/**
 * Встроенная панель старого консультанта (`variant="embedded"`) для
 * how-it-works — без кода чата в First Load JS страницы в режиме
 * `platform` (пункт TODO «how-it-works — AssistantWidget в бандле в
 * режиме platform»).
 *
 * Почему не просто условие в странице. Режим выбирается на сервере
 * (`assistWidgetFromBuildEnv()`), но клиентские компоненты попадают в
 * бандл страницы по ИМПОРТАМ серверного графа, а не по тому, что
 * отрисовано: со статическим `import { AssistantWidget }` чат лежал в
 * First Load JS how-it-works в обоих режимах.
 *
 * Как. Ветка выбирается по `process.env.NEXT_PUBLIC_ASSIST_WIDGET`,
 * который `next build` вклеивает строкой, — webpack сворачивает сравнение
 * в константу и мёртвую ветку не обходит (тот же приём, что
 * `if (process.env.NODE_ENV === 'production') require(…)` в react):
 *  - не `platform` (умолчание `legacy`) — обычный синхронный `require`:
 *    панель в чанке страницы, как раньше: нет лишнего запроса чанка, и
 *    запрос конфига (`/assistant/config`) уходит сразу при гидратации, на
 *    круг раньше, чем через `lazy`. Серверной отрисовки панели нет ни
 *    здесь, ни в `platform`, ни до этой правки: `AssistantWidget` до
 *    загрузки конфига возвращает `null`, `<aside>` в HTML сервера пуст;
 *  - `platform` — `React.lazy`: `require` выкинут, чат — отдельный чанк
 *    (тот же, что у ленивого плавающего виджета главной) и грузится,
 *    только если панель действительно отрисована. Это запасной путь на
 *    случай `platform` с кривым адресом/ключом: `resolveAssistWidget`
 *    тогда возвращает `legacy`, и консультант не должен пропасть.
 *
 * Не `next/dynamic`: его рантайм (+~0,8 КБ gzip — Loadable, PreloadCss,
 * BailoutToCSR) попал бы в чанк страницы при незаданной переменной, когда
 * сравнение не сворачивается, то есть в нынешнем проде. `React.lazy` уже
 * в React; `ssr: false` к тому же оставил бы в `<aside>` шаблон
 * BAILOUT_TO_CLIENT_SIDE_RENDERING, и `.how-it-works-assistant:empty` не
 * сработал бы. Suspense-комментарии `<!--$--><!--/$-->` `:empty` не мешают.
 *
 * Замер `npm run budget:js` (gzip -9, First Load JS `/[locale]/how-it-works`,
 * 08.10.2026; в скобках — таблица `next build`):
 *   было:  legacy 107,3 КБ (109 kB), platform 107,3 КБ (109 kB);
 *   стало: legacy 107,4 КБ без переменной / 107,3 КБ с явным `legacy`
 *          (109 kB), platform 103,2 КБ (105 kB).
 * Отвергнутые варианты: `next/dynamic` с `ssr: true` всегда — 104,0 КБ в
 * обоих режимах, но в legacy чат (4,6 КБ) догружается отдельным запросом
 * после гидратации и запрос конфига уезжает на один круг позже; выбор
 * через `require` + `next/dynamic` — legacy 108,1 КБ.
 *
 * Сравнение — ровно `=== 'platform'` без `.trim()` и прочего: иначе
 * webpack его не свернёт. Значение с пробелами (`' platform'`) просто
 * оставит синхронную ветку — тяжелее, но работает.
 */

type Props = ComponentProps<typeof AssistantWidget>;

function lazyEmbedded(): ComponentType<Props> {
  const Lazy = lazy(() => import('./AssistantWidget').then((m) => ({ default: m.AssistantWidget })));
  return function LazyEmbeddedAssistantWidget(props: Props) {
    return (
      <Suspense fallback={null}>
        <Lazy {...props} />
      </Suspense>
    );
  };
}

export const EmbeddedAssistantWidget: ComponentType<Props> =
  process.env.NEXT_PUBLIC_ASSIST_WIDGET === 'platform'
    ? lazyEmbedded()
    : (require('./AssistantWidget') as typeof import('./AssistantWidget')).AssistantWidget;
