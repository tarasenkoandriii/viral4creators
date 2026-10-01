import { BRAND } from '../brand';

/**
 * Подстановка `{имя}` в строку словаря. `{brand}` подставляется всегда —
 * имя бренда в словарях литералом не пишется (см. `brand.ts`).
 * Неизвестный плейсхолдер — ошибка: молча оставленный `{n}` в тексте
 * хуже падения сборки. Паритет плейсхолдеров между локалями держит
 * `scripts/dictionaries.test.ts`.
 */
export function fmt(template: string, vars: Record<string, string | number> = {}): string {
  const all: Record<string, string | number> = { brand: BRAND.name, ...vars };
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_, key: string) => {
    if (!(key in all)) throw new Error(`fmt: нет значения для {${key}} в «${template}»`);
    return String(all[key]);
  });
}

/** Плейсхолдеры строки — для теста паритета локалей. */
export function placeholders(template: string): string[] {
  return [...template.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map((m) => m[1]).sort();
}
