import {
  greetingReadiness,
  productReadiness,
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

describe('готовность поздравления (§7.3, этап 12)', () => {
  const base = {
    occasion: 'BIRTHDAY',
    customOccasionText: null,
    recipientName: 'Марина',
    senderName: 'Андрей',
    usesAvatar: false,
    referenceImages: 1,
    hasPrompt: true,
    promptFlagged: false,
  };

  it('всё заполнено — можно генерировать', () => {
    expect(greetingReadiness(base).canGenerate).toBe(true);
  });

  it('без сценария генерировать нечего', () => {
    const r = greetingReadiness({ ...base, hasPrompt: false });
    expect(r.canGenerate).toBe(false);
    expect(r.items.find((i) => i.key === 'script')?.done).toBe(false);
  });

  it('пункт «сценарий прошёл проверку» появляется только со сценарием', () => {
    // До сценария это не задача, а шум: человек увидел бы «осталось 2»
    // там, где дела ровно одно.
    const before = greetingReadiness({ ...base, hasPrompt: false });
    expect(before.items.some((i) => i.key === 'scriptClean')).toBe(false);
    expect(before.missingRequired).toBe(1);

    const flagged = greetingReadiness({ ...base, promptFlagged: true });
    expect(flagged.items.find((i) => i.key === 'scriptClean')?.done).toBe(
      false,
    );
    expect(flagged.canGenerate).toBe(false);
  });

  it('текст повода спрашивается только у повода «другое»', () => {
    expect(base.occasion).not.toBe('OTHER');
    expect(
      greetingReadiness(base).items.some((i) => i.key === 'occasionText'),
    ).toBe(false);
    const other = greetingReadiness({
      ...base,
      occasion: 'OTHER',
      customOccasionText: null,
    });
    expect(other.items.find((i) => i.key === 'occasionText')?.required).toBe(
      true,
    );
    expect(other.canGenerate).toBe(false);
  });

  it('лицо обязательно только говорящему аватару', () => {
    // Сервер отказывает в рендере аватара без портрета; у обычного
    // ведущего фото — дело вкуса.
    const avatar = greetingReadiness({
      ...base,
      usesAvatar: true,
      referenceImages: 0,
    });
    expect(avatar.items.find((i) => i.key === 'face')?.required).toBe(true);
    expect(avatar.canGenerate).toBe(false);

    const plain = greetingReadiness({ ...base, referenceImages: 0 });
    expect(plain.items.some((i) => i.key === 'face')).toBe(false);
    expect(plain.canGenerate).toBe(true);
  });

  it('фото у аватара не дублируется необязательным пунктом', () => {
    const avatar = greetingReadiness({ ...base, usesAvatar: true });
    expect(avatar.items.filter((i) => i.stepId === 'references')).toHaveLength(
      1,
    );
  });

  it('отправитель влияет, но не блокирует', () => {
    const r = greetingReadiness({ ...base, senderName: null });
    expect(r.items.find((i) => i.key === 'sender')?.required).toBe(false);
    expect(r.canGenerate).toBe(true);
  });
});

describe('готовность товарки (§7.3, этап 13)', () => {
  const base = {
    analysisComplete: true,
    hasSceneTemplate: false,
    hasProductInfo: true,
    hasProductImage: true,
    promptApproved: true,
    hasBrandManifest: true,
  };

  it('всё готово — можно генерировать', () => {
    expect(productReadiness(base).canGenerate).toBe(true);
  });

  it('каждое из четырёх условий блокирует по отдельности', () => {
    // Ровно те четыре, которые бросают сервисы: два в `PromptService`,
    // два в `GenerationService`.
    for (const key of [
      'analysisComplete',
      'hasProductInfo',
      'hasProductImage',
      'promptApproved',
    ] as const) {
      const r = productReadiness({ ...base, [key]: false });
      expect(r.canGenerate).toBe(false);
      expect(r.missingRequired).toBe(1);
    }
  });

  it('шаблон сцены закрывает тот же пункт, что и разбор', () => {
    // «Откуда берётся сцена» — один вопрос с двумя ответами. Отдельный
    // пункт «нужен разбор» у человека, сознательно обошедшегося без
    // референса, был бы требованием сделать то, чего от него не хотят
    // (этап 149, TODO §III п.11).
    const r = productReadiness({
      ...base,
      analysisComplete: false,
      hasSceneTemplate: true,
    });
    expect(r.canGenerate).toBe(true);
    expect(r.items.find((i) => i.key === 'analysis')?.done).toBe(true);
  });

  it('без разбора и без шаблона пункт не закрыт', () => {
    const r = productReadiness({
      ...base,
      analysisComplete: false,
      hasSceneTemplate: false,
    });
    expect(r.canGenerate).toBe(false);
    expect(r.items.find((i) => i.key === 'analysis')?.done).toBe(false);
  });

  it('бренд-манифест влияет, но не блокирует', () => {
    const r = productReadiness({ ...base, hasBrandManifest: false });
    expect(r.canGenerate).toBe(true);
    expect(r.items.find((i) => i.key === 'brandManifest')?.required).toBe(
      false,
    );
  });

  it('пункты ведут на свои шаги степпера', () => {
    // Строка готовности кликается, и вести она должна туда, где это
    // заполняют, — иначе «не хватает фото» это сообщение, а не путь.
    const byKey = Object.fromEntries(
      productReadiness(base).items.map((i) => [i.key, i.stepId]),
    );
    expect(byKey).toEqual({
      analysis: 'analysis',
      product: 'product',
      photo: 'product',
      prompt: 'prompt',
      brandManifest: 'product',
    });
  });
});
