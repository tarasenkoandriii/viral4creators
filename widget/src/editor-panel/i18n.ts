/**
 * Тексты панели редактора голосовой карты (uk/ru/en; сверка ключей —
 * scripts/editor.test.ts). Заход 10 (разгрузка бюджета `editor-panel`, ≈ −3
 * КБ gzip): в чанке панели — только `uk` (он же запасной); `ru`/`en` —
 * ленивые ES-модули `/v1/editor-panel-ru.js` и `/v1/editor-panel-en.js` своего
 * origin `we.` (CSP `script-src 'self'`; `import()` — не приёмник Trusted
 * Types). Язык приходит с `ready` пикера; до загрузки словаря и при сбое
 * сети — украинский, как и раньше до `ready`.
 */
import uk from './lang-uk';

export type PanelLang = 'uk' | 'ru' | 'en';
export type Dict = Record<string, string>;

export const T: { uk: Dict } & Partial<Record<PanelLang, Dict>> = { uk };

/** Подгрузить словарь языка (один раз); без него — `uk`. */
export async function loadLang(l: PanelLang): Promise<void> {
  if (T[l]) return;
  try {
    // Аудит Ж (P3-6): словарь не пришёл за 3 с — панель на uk, не ждёт.
    const m = (await Promise.race([
      import(/* @vite-ignore */ `/v1/editor-panel-${l}.js`),
      new Promise((_, no) => setTimeout(no, 3000)),
    ])) as { default?: unknown };
    const d = m.default;
    // Поверх uk: ключ, которого нет в словаре другого выпуска, — по-украински.
    if (d && typeof d === 'object') T[l] = { ...uk, ...(d as Dict) };
  } catch {
    /* сеть/старый выпуск — остаётся uk */
  }
}

export function fmt(s: string, v: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (_, k: string) =>
    k in v ? String(v[k]) : `{${k}}`
  );
}
