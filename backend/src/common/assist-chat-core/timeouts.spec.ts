import { createChatAbort, DEFAULT_CHAT_TIMEOUTS } from './timeouts';

describe('createChatAbort', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const t = { firstTokenMs: 100, totalMs: 1000 };

  it('значения лендинга: 30 с до первого токена, 90 с на ответ', () => {
    expect(DEFAULT_CHAT_TIMEOUTS).toEqual({
      firstTokenMs: 30_000,
      totalMs: 90_000,
    });
  });

  it('нет первого токена за firstTokenMs — отмена', () => {
    const h = createChatAbort(t);
    jest.advanceTimersByTime(99);
    expect(h.signal.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    expect(h.signal.aborted).toBe(true);
  });

  it('первый токен пришёл — до totalMs не отменяется, на totalMs — отмена', () => {
    const h = createChatAbort(t);
    h.firstTokenArrived();
    jest.advanceTimersByTime(999);
    expect(h.signal.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    expect(h.signal.aborted).toBe(true);
  });

  it('clear() снимает оба таймера', () => {
    const h = createChatAbort(t);
    h.clear();
    jest.advanceTimersByTime(10_000);
    expect(h.signal.aborted).toBe(false);
  });

  it('внешний сигнал (уход клиента) отменяет сразу', () => {
    const ext = new AbortController();
    const h = createChatAbort(t, ext.signal);
    expect(h.signal.aborted).toBe(false);
    ext.abort();
    expect(h.signal.aborted).toBe(true);
    h.clear();
  });

  it('уже отменённый внешний сигнал — отменено с самого начала', () => {
    const ext = new AbortController();
    ext.abort();
    const h = createChatAbort(t, ext.signal);
    expect(h.signal.aborted).toBe(true);
    h.clear();
  });
});
