import {
  isTerminal,
  nextAttemptAt,
  requestFingerprint,
  toJobView,
  type ApiVideoRequest,
} from './api-video-job';

/**
 * Этап 145. Заявка внешнего API на ролик — чистые правила.
 */
const request = (over: Partial<ApiVideoRequest> = {}): ApiVideoRequest => ({
  productItemId: 'item-1',
  libraryEntryId: 'lib-1',
  quality: 'fast',
  aspectRatio: null,
  locale: null,
  ...over,
});

describe('requestFingerprint', () => {
  it('одинаковые запросы дают одинаковый отпечаток', () => {
    expect(requestFingerprint(request())).toBe(requestFingerprint(request()));
  });

  it('порядок ключей в объекте на отпечаток не влияет', () => {
    // Поля перечислены явно, а не через `JSON.stringify`: порядок
    // ключей зависит от того, как объект собрали, и одинаковые по
    // смыслу запросы дали бы разные отпечатки.
    const a: ApiVideoRequest = {
      productItemId: 'item-1',
      libraryEntryId: 'lib-1',
      quality: 'fast',
      aspectRatio: null,
      locale: null,
    };
    const b: ApiVideoRequest = {
      locale: null,
      aspectRatio: null,
      quality: 'fast',
      libraryEntryId: 'lib-1',
      productItemId: 'item-1',
    };
    expect(requestFingerprint(a)).toBe(requestFingerprint(b));
  });

  it('любое значащее поле меняет отпечаток', () => {
    const base = requestFingerprint(request());
    for (const other of [
      request({ productItemId: 'item-2' }),
      request({ libraryEntryId: 'lib-2' }),
      request({ quality: 'standard' }),
      request({ aspectRatio: '9:16' }),
      request({ locale: 'en' }),
    ]) {
      expect(requestFingerprint(other)).not.toBe(base);
    }
  });

  it('склейка полей не путает соседние значения', () => {
    // Разделитель нужен: «ab»+«c» и «a»+«bc» иначе дали бы один
    // отпечаток, и разные заявки считались бы повтором друг друга.
    expect(
      requestFingerprint(request({ productItemId: 'ab', libraryEntryId: 'c' })),
    ).not.toBe(
      requestFingerprint(request({ productItemId: 'a', libraryEntryId: 'bc' })),
    );
  });
});

describe('nextAttemptAt', () => {
  const now = new Date('2026-09-25T10:00:00Z');

  it('пауза удваивается: 2, 4, 8 минут', () => {
    expect(nextAttemptAt(1, now).getTime() - now.getTime()).toBe(2 * 60_000);
    expect(nextAttemptAt(2, now).getTime() - now.getTime()).toBe(4 * 60_000);
    expect(nextAttemptAt(3, now).getTime() - now.getTime()).toBe(8 * 60_000);
  });

  it('нулевая попытка не даёт паузу в минуту', () => {
    // 2^0 = 1 минута: повтор через минуту после отказа успевает
    // повторить его же, пока причина не изменилась.
    expect(nextAttemptAt(0, now).getTime() - now.getTime()).toBe(2 * 60_000);
  });
});

describe('isTerminal', () => {
  it('за законченной заявкой ходить незачем', () => {
    expect(isTerminal('DONE')).toBe(true);
    expect(isTerminal('FAILED')).toBe(true);
    expect(isTerminal('QUEUED')).toBe(false);
    expect(isTerminal('RUNNING')).toBe(false);
  });
});

describe('toJobView', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'job-1',
    status: 'DONE',
    videoUrl: 'https://blob.test/v.mp4',
    error: null,
    createdAt: new Date('2026-09-25T10:00:00Z'),
    updatedAt: new Date('2026-09-25T10:05:00Z'),
    ...over,
  });

  it('готовая заявка отдаёт ссылку', () => {
    expect(toJobView(row() as never)).toEqual({
      jobId: 'job-1',
      status: 'DONE',
      videoUrl: 'https://blob.test/v.mp4',
      error: null,
      createdAt: '2026-09-25T10:00:00.000Z',
      updatedAt: '2026-09-25T10:05:00.000Z',
    });
  });

  it('недоделанный ролик по ссылке не отдаётся', () => {
    // Он ещё меняется — постобработка режет кадр и кладёт звук. Ссылка
    // из `RUNNING` выглядела бы как результат.
    expect(toJobView(row({ status: 'RUNNING' }) as never).videoUrl).toBeNull();
  });

  it('причина показывается только у неудавшейся', () => {
    // След прошлой неудачной попытки у заявки, которая потом пошла
    // дальше, читался бы как «всё сломалось» при работающем рендере.
    expect(
      toJobView(row({ status: 'RUNNING', error: 'сеть' }) as never).error,
    ).toBeNull();
    expect(
      toJobView(row({ status: 'FAILED', error: 'сеть' }) as never).error,
    ).toBe('сеть');
  });

  it('в ответе нет ничего, кроме обещанного', () => {
    // Чужой код видит ровно эти поля; лишнее в ответе становится
    // контрактом молча.
    expect(Object.keys(toJobView(row() as never)).sort()).toEqual([
      'createdAt',
      'error',
      'jobId',
      'status',
      'updatedAt',
      'videoUrl',
    ]);
  });
});
