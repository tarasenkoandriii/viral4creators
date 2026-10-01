/**
 * Заглушка этапа: интерфейс зафиксирован архитектором (Э1 — контракт
 * /tmp/k/CONTRACT-E1.md, агенты K1–K4; Э2 — /tmp/k/CONTRACT-E2.md, агенты
 * W1–W5), реализацию пишет указанный агент. Вызов до реализации — громкая
 * ошибка, а не тихий пустой результат.
 *
 * Удалить файл, когда в src не останется ни одного вызова (grep
 * `notImplemented(`) — это проверка «этап закрыт» для координатора.
 */
export type StubOwner = 'K1' | 'K2' | 'K3' | 'W2' | 'W3' | 'W4' | 'W5';

export class NotImplementedYetError extends Error {
  constructor(owner: StubOwner, what: string) {
    const stage = owner.startsWith('W') ? 'Э2' : 'Э1';
    super(`${stage}: не реализовано (${owner}): ${what}`);
    this.name = 'NotImplementedYetError';
  }
}

export function notImplemented(owner: StubOwner, what: string): never {
  throw new NotImplementedYetError(owner, what);
}
