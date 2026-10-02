/**
 * Заглушка этапа: интерфейс зафиксирован архитектором (Э3 — контракт
 * /tmp/k/CONTRACT-E3.md, агенты H, A, L, W, T), реализацию пишет указанный
 * агент. Вызов до реализации — громкая ошибка, а не тихий пустой результат.
 *
 * Удалить файл, когда в src не останется ни одного вызова (grep
 * `notImplemented(`) — это проверка «этап закрыт» для координатора.
 *
 * Агенты Э3: H — передача человеку; A — цели, статистика, отчёты;
 * L — обучение на диалогах; W — виджет и его публичный HTTP; T — TMA,
 * настройки вовлечения, пакеты интеграций.
 */
export type StubOwner = 'H' | 'A' | 'L' | 'W' | 'T';

export class NotImplementedYetError extends Error {
  constructor(owner: StubOwner, what: string) {
    super(`Э3: не реализовано (${owner}): ${what}`);
    this.name = 'NotImplementedYetError';
  }
}

export function notImplemented(owner: StubOwner, what: string): never {
  throw new NotImplementedYetError(owner, what);
}
