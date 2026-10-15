/**
 * Подстановка `{имя}` в строку словаря. `{brand}` здесь НЕ подставляется:
 * строки из `getDictionary(locale)` приходят с уже подставленным именем
 * на языке страницы (`brandDisplayName`, Р-З15-1), а прочие шаблоны
 * (юр-черновики) передают `brand` явно. Неизвестный плейсхолдер — ошибка:
 * молча оставленный `{n}` (и `{brand}` мимо локали) в тексте хуже
 * падения сборки. Паритет плейсхолдеров между локалями держит
 * `scripts/dictionaries.test.ts`.
 */
export function fmt(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_, key: string) => {
    if (!(key in vars)) throw new Error(`fmt: нет значения для {${key}} в «${template}»`);
    return String(vars[key]);
  });
}

/** Плейсхолдеры строки — для теста паритета локалей. */
export function placeholders(template: string): string[] {
  return [...template.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map((m) => m[1]).sort();
}
