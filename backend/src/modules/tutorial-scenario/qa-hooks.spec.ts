import { knownQaHook, qaSelector, QA_HOOKS } from './qa-hooks';
import { ROUTE_DESCRIPTIONS } from '../tutorial-runner/route-templates';
import {
  BRIEF_FIELD_HOOKS,
  SESSION_FIELD_HOOKS,
} from '../../common/greeting-voice-intent';

describe('QA_HOOKS', () => {
  it('каждый хук живёт на маршруте, который предлагается модели', () => {
    for (const [key, hook] of Object.entries(QA_HOOKS)) {
      expect({ key, known: hook.route in ROUTE_DESCRIPTIONS }).toEqual({
        key,
        known: true,
      });
    }
  });

  it('ключи в форме, которую понимает knownQaHook, и описаны', () => {
    for (const [key, hook] of Object.entries(QA_HOOKS)) {
      expect(knownQaHook(qaSelector(key))).toBe(key);
      expect(hook.description.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('knownQaHook', () => {
  it('принимает только [data-qa="ключ"] из каталога', () => {
    expect(knownQaHook('[data-qa="prompt-approve"]')).toBe('prompt-approve');
    expect(knownQaHook('  [data-qa="prompt-approve"]  ')).toBe(
      'prompt-approve',
    );
    expect(knownQaHook('[data-qa="no-such"]')).toBeNull();
    expect(knownQaHook("[data-qa='prompt-approve']")).toBeNull();
    expect(knownQaHook('[data-qa="prompt-approve"] span')).toBeNull();
    expect(knownQaHook('#promptText')).toBeNull();
    // Ключ-свойство объекта не должно считаться хуком.
    expect(knownQaHook('[data-qa="constructor"]')).toBeNull();
  });
});

describe('позиции степпера кликабельны только у пройденных шагов', () => {
  // Находка боевого прогона 29.09.2026: `Stepper.tsx` рисует каждую
  // позицию как `<button disabled={!clickable}>`, а `clickable`
  // истинно только у пройденного шага. Модель читала описание
  // «позиция «Товар» в степпере мастера» как приглашение перейти и
  // писала `goto generate` → `click wizard-step-product` вторым
  // шагом; на свежем мастере эта кнопка выключена, и восемь сценариев
  // из девяти падали таймаутом в тридцать секунд.
  const stepperKeys = Object.keys(QA_HOOKS).filter((k) => k.includes('-step-'));

  it('их тринадцать, и все помечены', () => {
    // Список выписан руками, а не выведен из самого каталога: тест,
    // перебирающий то же, что и код, согласится с любой его
    // редакцией — включая ту, где пометку сняли со всех.
    expect(stepperKeys.sort()).toEqual([
      // Поздравление (29.09.2026): степпер из четырёх позиций, и у него
      // та же ловушка — текущий шаг нарисован, но выключен. Какая
      // позиция жива на каком экране, проверяет шов check-docs по
      // таблице `LIVE_BY_ROUTE` во `frontend/scripts/greeting-steps.test.ts`.
      'greeting-step-brief',
      'greeting-step-references',
      'greeting-step-script',
      'greeting-step-video',
      'item-step-analogs',
      'item-step-photo',
      'item-step-price',
      'item-step-voice',
      'wizard-step-analysis',
      'wizard-step-product',
      'wizard-step-prompt',
      'wizard-step-upload',
      'wizard-step-video',
    ]);
    for (const key of stepperKeys) {
      expect(QA_HOOKS[key].clickOnlyWhenVisited).toBe(true);
    }
  });

  it('обычные хуки пометки не носят — иначе она ничего не значит', () => {
    expect(QA_HOOKS['video-generate'].clickOnlyWhenVisited).toBeUndefined();
    expect(
      QA_HOOKS['reference-link-submit'].clickOnlyWhenVisited,
    ).toBeUndefined();
    const marked = Object.values(QA_HOOKS).filter(
      (h) => h.clickOnlyWhenVisited,
    );
    expect(marked).toHaveLength(stepperKeys.length);
  });
});

describe('поля брифа поздравления (этап K3 — голос адресует их хуками)', () => {
  // Выписаны руками — те же одиннадцать имён, что в контракте волны K и
  // в `BRIEF_FIELD_HOOKS` (`common/greeting-voice-intent.ts`).
  const FIELDS = [
    'greeting-field-occasion',
    'greeting-field-custom-occasion',
    'greeting-field-mood',
    'greeting-field-recipient',
    'greeting-field-sender',
    'greeting-field-tone',
    'greeting-field-message',
    'greeting-field-script-language',
    'greeting-field-presenter',
    'greeting-field-resolution',
    'greeting-field-date',
  ];

  it('все одиннадцать — на экране брифа без сессии', () => {
    for (const key of FIELDS) {
      expect({ key, route: QA_HOOKS[key]?.route }).toEqual({
        key,
        route: 'greeting-video',
      });
    }
    expect(
      Object.keys(QA_HOOKS).filter((k) => k.startsWith('greeting-field-')),
    ).toHaveLength(FIELDS.length);
  });

  it('совпадают с хуками голосового разбора', () => {
    expect(Object.values(BRIEF_FIELD_HOOKS).sort()).toEqual([...FIELDS].sort());
  });

  it('поля «Особого повода» на стенде не рисуются — помечены отсутствием', () => {
    for (const key of [
      'greeting-field-custom-occasion',
      'greeting-field-mood',
    ]) {
      expect(QA_HOOKS[key].absentWhen?.why).toMatch(/Особом повод/);
    }
  });

  it('списки, группы и дата — только ждать и проверять; повод — не менять', () => {
    for (const key of [
      'greeting-field-occasion',
      'greeting-field-tone',
      'greeting-field-script-language',
      'greeting-field-presenter',
      'greeting-field-resolution',
      'greeting-field-date',
    ]) {
      expect(QA_HOOKS[key].description).toContain(
        'Только waitFor/assertVisible',
      );
    }
    expect(QA_HOOKS['greeting-field-occasion'].description).toContain(
      'менять его сценарию нельзя',
    );
  });

  it('текстовые поля — fill, с потолком длины, как у экрана', () => {
    for (const key of [
      'greeting-field-recipient',
      'greeting-field-sender',
      'greeting-field-message',
    ]) {
      expect(QA_HOOKS[key].description).toContain('fill');
      expect(QA_HOOKS[key].absentWhen).toBeUndefined();
      expect(QA_HOOKS[key].clickCost).toBeUndefined();
    }
  });
});

describe('элементы карточек сессии (этап K5 — голос адресует их хуками)', () => {
  const kindOf = new Map(
    Object.values(SESSION_FIELD_HOOKS).map((s) => [s.hook, s.kind]),
  );

  it('каждый голосовой элемент сессии есть в каталоге обучалки', () => {
    for (const hook of kindOf.keys()) {
      expect({ hook, known: hook in QA_HOOKS }).toEqual({ hook, known: true });
    }
  });

  it('текстовые поля — fill; группы вариантов — только ждать и проверять', () => {
    const expected = (kind: string) =>
      kind === 'field'
        ? 'fill'
        : kind === 'list'
          ? 'Только waitFor/assertVisible'
          : '';
    for (const [hook, kind] of kindOf) {
      expect({ hook, d: QA_HOOKS[hook].description }).toEqual({
        hook,
        d: expect.stringContaining(expected(kind)),
      });
      // Поля и кнопки «убрать» — даром. Группа вариантов — контейнер:
      // клик по нему попал бы в случайную кнопку, поэтому запрещён.
      expect({ hook, cost: QA_HOOKS[hook].clickCost }).toEqual({
        hook,
        cost: kind === 'list' ? 'forbidden' : undefined,
      });
    }
  });

  it('блок своих голосов есть всегда — без absentWhen, клик запрещён', () => {
    expect(QA_HOOKS['greeting-voice-clone'].absentWhen).toBeUndefined();
    expect(QA_HOOKS['greeting-voice-clone'].clickCost).toBe('forbidden');
  });

  it('форма фото открывается без файла — причина не врёт', () => {
    for (const key of [
      'greeting-references-label',
      'greeting-references-description',
    ]) {
      expect(QA_HOOKS[key].absentWhen?.why).toContain('файл выбирать не нужно');
    }
  });

  it('галочки «убрать» — только при выбранном, и это объявлено', () => {
    const toggles = [...kindOf].filter(([, k]) => k === 'toggle');
    expect(toggles).toHaveLength(3);
    for (const [hook] of toggles) {
      expect(QA_HOOKS[hook].absentWhen?.why).toMatch(/только когда/);
    }
  });

  it('наклейка без ключа и пресеты без ключа провайдера — через env', () => {
    expect(QA_HOOKS['greeting-sticker-query'].absentWhen?.env).toBe(
      'PIXABAY_API_KEY',
    );
    expect(QA_HOOKS['greeting-voice-preset'].absentWhen?.env).toBe(
      'GROK_API_KEY',
    );
  });
});

describe('контейнеры групп кнопок (финальный аудит ветки K)', () => {
  it('брифовые группы — тон, настроение, ведущий — нажимать нельзя', () => {
    for (const key of [
      BRIEF_FIELD_HOOKS.tone,
      BRIEF_FIELD_HOOKS.mood,
      BRIEF_FIELD_HOOKS.presenter,
    ]) {
      expect({ key, clickCost: QA_HOOKS[key]?.clickCost }).toEqual({
        key,
        clickCost: 'forbidden',
      });
    }
  });

  it('любой хук, описанный как «группа кнопок», — clickCost: forbidden', () => {
    const groups = Object.entries(QA_HOOKS).filter(([, h]) =>
      /группа кнопок/i.test(h.description),
    );
    expect(groups.length).toBeGreaterThanOrEqual(7);
    for (const [key, hook] of groups) {
      expect({ key, clickCost: hook.clickCost }).toEqual({
        key,
        clickCost: 'forbidden',
      });
    }
  });
});
