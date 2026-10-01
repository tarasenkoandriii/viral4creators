/**
 * Точка входа Vercel — тот же приём, что у backend/server.js (там подробно,
 * почему именно так): Vercel находит `server.js` в корне проекта, который
 * вызывает `.listen()`, и превращает его в одну функцию; маршрутизацией
 * занимается сам Nest.
 *
 * Требуем СКОМПИЛИРОВАННЫЙ `dist/main.js`, а не исходник: DI Nest держится
 * на `emitDecoratorMetadata`, которую выдаёт только настоящий `tsc`
 * (`npm run build` → `nest build`), а не esbuild-трансформация Vercel.
 */
require('./dist/main.js');
