import {
  clientSiteReadiness,
  readinessOf,
  type ReadinessItem,
} from './wizard-readiness';

const item = (over: Partial<ReadinessItem> = {}): ReadinessItem => ({
  key: 'k',
  stepId: 's',
  required: true,
  done: false,
  ...over,
});

describe('wizard-readiness', () => {
  it('необязательный незакрытый пункт не блокирует генерацию', () => {
    // Свалить всё в «обязательно» — соврать: голос, музыка и сцены
    // меняют результат, но кнопку не держат. Не показать вовсе —
    // молча отдать человеку худший ролик.
    const r = readinessOf([
      item({ required: true, done: true }),
      item({ key: 'nice', required: false, done: false }),
    ]);
    expect(r.missingRequired).toBe(0);
    expect(r.canGenerate).toBe(true);
  });

  it('обязательный незакрытый пункт считается и блокирует', () => {
    const r = readinessOf([item(), item({ key: 'b', done: true })]);
    expect(r.missingRequired).toBe(1);
    expect(r.canGenerate).toBe(false);
  });

  it('у каждого пункта есть шаг — иначе строка ведёт в тупик', () => {
    // Без `stepId` «не хватает заголовка» это сообщение, а не путь.
    for (const i of clientSiteReadiness(null).items) {
      expect(i.stepId).toBeTruthy();
    }
  });
});

describe('готовность обучалки (§7.3)', () => {
  const draft = (
    over: Partial<Parameters<typeof clientSiteReadiness>[0]> = {},
  ) =>
    clientSiteReadiness({
      status: 'DRAFTING',
      frames: 1,
      title: 'Как оформить заказ',
      ...over,
    });

  const keyDone = (r: ReturnType<typeof clientSiteReadiness>, key: string) =>
    r.items.find((i) => i.key === key)?.done;

  it('без черновика не закрыто ничего обязательного', () => {
    const r = clientSiteReadiness(null);
    expect(r.missingRequired).toBe(3);
    expect(r.canGenerate).toBe(false);
  });

  it('полный черновик готов к отправке', () => {
    expect(draft().canGenerate).toBe(true);
  });

  it('ни одного кадра — не готов', () => {
    // Ровно предусловие `finish()`: «в черновике нет ни одного кадра».
    expect(keyDone(draft({ frames: 0 }), 'frames')).toBe(false);
    expect(draft({ frames: 0 }).canGenerate).toBe(false);
  });

  it('пустой и пробельный заголовок — одно и то же', () => {
    expect(keyDone(draft({ title: null }), 'title')).toBe(false);
    expect(keyDone(draft({ title: '   ' }), 'title')).toBe(false);
  });

  it('черновик на модерации не блокирует, но об этом сказано', () => {
    // Доработать после модерации — обычный путь, а не ошибка. Но если
    // промолчать, человек жмёт «Готово» и получает отказ без
    // объяснения.
    const r = draft({ status: 'PENDING_REVIEW' });
    expect(keyDone(r, 'editable')).toBe(false);
    expect(r.canGenerate).toBe(true);
    expect(r.items.find((i) => i.key === 'editable')?.required).toBe(false);
  });

  it('счётчика «осталось N шагов» здесь нет и быть не может', () => {
    // Раундов записи столько, сколько потребует сайт заказчика.
    // Прогресс-бар, не знающий своей длины, врёт каждым пикселем —
    // наружу идут условия, а не число.
    const r = draft({ frames: 7 });
    expect(r.items.every((i) => typeof i.done === 'boolean')).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/\b7\b/);
  });
});
