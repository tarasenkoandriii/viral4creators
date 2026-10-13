/**
 * Минимальные объявления Node для проверки типов в `scripts/`
 * (`tsconfig.scripts.json`), тот же приём, что у бэкенда с
 * `test/types/prisma-any/index.d.ts`.
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
    rejects(p: Promise<unknown>, message?: string): Promise<void>;
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
  // Z-2b: драйвер сквозных маршрутов `publisher-e2e.ts` пишет итог в файл.
  export function writeFileSync(path: string | URL, data: string): void;
}

// Z-2b: `publisher-e2e.ts` — подпись initData стенда и `pg` из зависимостей
// sites-backend (синтетическое время стенда).
declare module 'node:crypto' {
  interface Hmac {
    update(data: string | Uint8Array): Hmac;
    digest(): Uint8Array;
    digest(encoding: 'hex'): string;
  }
  export function createHmac(alg: string, key: string | Uint8Array): Hmac;
  export function randomUUID(): string;
}
declare module 'node:module' {
  export function createRequire(from: string | URL): (id: string) => unknown;
}

declare const process: {
  exit(code?: number): never;
  exitCode?: number;
  argv: string[];
  env: Record<string, string | undefined>;
};

// Э3: `widget-api.test.ts` сверяет инструкции установки с серверным
// `snippet.ts`, а тот импортирует `keys.ts` (генератор ключа на
// `randomBytes`). Сам тест ключей не генерирует — нужен только тип.
declare module 'crypto' {
  export function randomBytes(size: number): Uint8Array;
}
