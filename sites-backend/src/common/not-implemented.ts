/**
 * Заглушка Э1: интерфейс зафиксирован архитектором (контракт Э1,
 * /tmp/k/CONTRACT-E1.md), реализацию пишет указанный агент. Вызов до
 * реализации — громкая ошибка, а не тихий пустой результат.
 *
 * Удалить файл, когда в src не останется ни одного вызова (grep
 * `notImplemented(`) — это проверка «этап закрыт» для координатора.
 */
export class NotImplementedYetError extends Error {
  constructor(owner: string, what: string) {
    super(`Э1: не реализовано (${owner}): ${what}`);
    this.name = 'NotImplementedYetError';
  }
}

export function notImplemented(owner: 'K1' | 'K2' | 'K3', what: string): never {
  throw new NotImplementedYetError(owner, what);
}
