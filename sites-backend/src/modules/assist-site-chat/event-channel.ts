/**
 * Очередь событий ответа — W3. Конвейер пишет в неё из ФОНОВОЙ задачи, а
 * маршрут W2 читает как AsyncIterable. Зачем не просто async-генератор:
 * разрыв соединения (W2 перестаёт читать, `return()` у итератора) у
 * генератора остановил бы конвейер на ближайшем `yield` — без записи
 * ответа и без списания денег. Здесь читатель может уйти когда угодно,
 * а генерация доводится до конца (§4-бис.4).
 */
export class EventChannel<T> implements AsyncIterable<T> {
  private readonly buf: T[] = [];
  private ended = false;
  private wake: (() => void) | null = null;

  push(ev: T): void {
    if (this.ended) return;
    this.buf.push(ev);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.buf.length) {
        yield this.buf.shift() as T;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}
