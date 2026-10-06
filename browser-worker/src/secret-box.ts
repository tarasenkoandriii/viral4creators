/**
 * Секрет учётки в памяти воркера (Э-С Ш3): Buffer, а не строка, —
 * его можно затереть (`fill(0)`); пока он жив, журнал вырезает его
 * значение (`registerSecret`). Строковая копия неизбежна в одном месте —
 * аргумент `page.fill()` Playwright (строки JS неизменяемы и не
 * затираются); `reveal` держит её только на время колбэка и не отдаёт
 * наружу. После `wipe()` секрет недоступен, повторный `reveal` — ошибка.
 */
import { registerSecret, unregisterSecret } from './logger';

export class SecretBox {
  private buf: Buffer | null;
  private registered: string | null;

  constructor(value: string | Buffer) {
    this.buf = Buffer.isBuffer(value)
      ? Buffer.from(value)
      : Buffer.from(value, 'utf8');
    if (Buffer.isBuffer(value)) value.fill(0);
    this.registered = this.buf.toString('utf8');
    registerSecret(this.registered);
  }

  get wiped(): boolean {
    return this.buf === null;
  }

  /** Сырые байты для проверки затирания в тестах. */
  bytesForTest(): Buffer | null {
    return this.buf;
  }

  async reveal<T>(fn: (plain: string) => Promise<T>): Promise<T> {
    if (!this.buf) throw new Error('секрет уже затёрт');
    return fn(this.buf.toString('utf8'));
  }

  wipe(): void {
    if (this.buf) this.buf.fill(0);
    if (this.registered) unregisterSecret(this.registered);
    this.registered = null;
    this.buf = null;
  }
}
