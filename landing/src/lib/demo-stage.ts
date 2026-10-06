import type { CSSProperties } from 'react';

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
