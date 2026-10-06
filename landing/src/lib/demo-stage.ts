import type { CSSProperties } from 'react';
import type { DemoTheme, TutorialDemo } from './tutorial-demo-api';

/**
 * Пропорция сцены плеера демо (`.demo-stage` в `globals.css`).
 *
 * Сцена берёт размер ДО загрузки ролика (`preload="none"`), иначе она
 * прыгала бы, когда браузер узнаёт настоящий размер. Источники по
 * старшинству: размер, измеренный самим `<video>` (`onLoadedMetadata`,
 * правда последней инстанции), размер из API, прежняя вертикаль
 * 720×1560 (`tutorial-video-assembly.ts`).
 *
 * Отдаются две CSS-переменные: `--demo-ar` — для `aspect-ratio`
 * (`w / h`), `--demo-ratio` — число w÷h для ширины
 * `min(100%, min(80vh, 720px) × ratio)`: вертикальный ролик ограничен
 * высотой экрана, горизонтальный упирается в ширину колонки.
 */
export const DEFAULT_DEMO_SIZE = { width: 720, height: 1560 } as const;

export interface DemoSize {
  width: number;
  height: number;
}

/** Размер из `<video>`: те же границы, что у размера из API. */
export function measuredDemoSize(width: number, height: number): DemoSize | null {
  const ok = (n: number) => Number.isInteger(n) && n >= 16 && n <= 7680;
  return ok(width) && ok(height) ? { width, height } : null;
}

export function demoStageSize(
  measured: DemoSize | null | undefined,
  fromApi: { width: number | null; height: number | null },
): DemoSize {
  if (measured) return measured;
  if (fromApi.width && fromApi.height) return { width: fromApi.width, height: fromApi.height };
  return DEFAULT_DEMO_SIZE;
}

export function demoStageStyle(size: DemoSize): CSSProperties {
  // Число — с ограниченной точностью: 0.46153846153846156 в атрибуте
  // style ничего не даёт, а сравнивать снимки HTML мешает.
  const ratio = Math.round((size.width / size.height) * 1e6) / 1e6;
  return {
    '--demo-ar': `${size.width} / ${size.height}`,
    '--demo-ratio': String(ratio),
  } as CSSProperties;
}

/**
 * Что показывает сцена: ролик, постер и размер одной темы.
 *
 * Тема лендинга на этот выбор не влияет (решение владельца: переключателя
 * темы на лендинге нет) — только системная тема посетителя,
 * `prefers-color-scheme`. Старшинство:
 *
 *  1. вариант темы посетителя;
 *  2. верхние поля, если записано, что сняты в этой теме;
 *  3. вариант другой темы — какой есть;
 *  4. верхние поля — прежнее поведение.
 *
 * `scheme === null` — тема ещё неизвестна (сервер, первый проход
 * гидрации): верхние поля, ровно как до вариантов, чтобы HTML сервера не
 * зависел от них.
 */
export interface DemoChoice {
  videoUrl: string;
  posterUrl: string | null;
  width: number | null;
  height: number | null;
  theme: DemoTheme | null;
}

export function pickDemoVariant(item: TutorialDemo, scheme: DemoTheme | null): DemoChoice {
  const top: DemoChoice = {
    videoUrl: item.videoUrl, posterUrl: item.posterUrl, width: item.width, height: item.height, theme: item.theme,
  };
  if (!scheme) return top;
  const own = item.variants?.[scheme];
  if (own) return { ...own, theme: scheme };
  if (item.theme === scheme) return top;
  const other: DemoTheme = scheme === 'dark' ? 'light' : 'dark';
  const fallback = item.variants?.[other];
  return fallback ? { ...fallback, theme: other } : top;
}

/** Запрос системной темы — один на сцену и тест. */
export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

export function schemeFromMatches(darkMatches: boolean): DemoTheme {
  return darkMatches ? 'dark' : 'light';
}
