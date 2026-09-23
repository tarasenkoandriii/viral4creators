/**
 * Минимальные объявления Node для проверки типов в `scripts/`
 * (`tsconfig.scripts.json`), тот же приём, что у бэкенда с
 * `test/types/prisma-client-ambient.d.ts`.
 *
 * Почему не `@types/node`. Корневой `tsconfig.json` держит `"types": []`
 * намеренно и объясняет почему: поднятый наверх `@types/node` меняет
 * тип `setTimeout` во ВСЁМ проекте с `number` на `NodeJS.Timeout`, и
 * сборка падает в файле, которого правка не касалась. Подключать его
 * ради пяти тестовых импортов значило бы вернуть ровно ту ловушку.
 *
 * Здесь объявлено только то, чем пользуются сами тесты. Чего нет в этом
 * файле — того нельзя и в тестах; это не ограничение, а цель.
 */

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}

declare module 'node:fs' {
  // `URL` в сигнатуре не для красоты: тесты читают файлы через
  // `new URL('…', import.meta.url)`, и объявление только под строку
  // отвергало бы рабочий код.
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
  export function existsSync(path: string | URL): boolean;
  export function readdirSync(path: string | URL): string[];
}

declare const process: {
  exit(code?: number): never;
  argv: string[];
  env: Record<string, string | undefined>;
};
