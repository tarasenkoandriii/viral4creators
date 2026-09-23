/**
 * Правила корпуса опыта и подстановка ключей словаря — «Тонкая красная
 * линия» §6.2, §6.5, §6.7, этап 9.
 */

import {
  authoritativeText,
  canPublish,
  experienceLine,
  serveDecision,
  textUiKeys,
  type ExperienceText,
} from './experience';
import { isKnownUiKey, renderUiKeys, sameUiKeys, uiKeysOf } from './ui-keys';

const text = (over: Partial<ExperienceText> = {}): ExperienceText => ({
  locale: 'ru',
  symptom: 'код не приходит',
  cause: 'активная сессия Telegram',
  advice: 'смотрите в приложении',
  source: 'ADMIN',
  reviewed: true,
  ...over,
});

describe('публикация (§6.5)', () => {
  it('без русского совета публиковать нечего', () => {
    // Русский — рабочий язык модерации: без него следующий оператор не
    // поймёт, что здесь утверждено, даже если сигнал пришёл на
    // испанском.
    expect(canPublish([text({ locale: 'es' })])).toBe(false);
    expect(canPublish([])).toBe(false);
  });

  it('непрочитанный русский совет тоже не даёт публиковать', () => {
    expect(canPublish([text({ reviewed: false })])).toBe(false);
  });

  it('прочитанный русский совет — можно', () => {
    expect(canPublish([text(), text({ locale: 'de', reviewed: false })])).toBe(
      true,
    );
  });
});

describe('авторитетный текст (§6.7, правило 3)', () => {
  it('переводить не с чего, пока ничего не прочитано', () => {
    // Перевод перевода: испорченный телефон на третьем языке уже
    // неразличим, а с этапа 11 он ещё и замораживается в базе.
    expect(
      authoritativeText([text({ locale: 'de', reviewed: false })]),
    ).toBeNull();
  });

  it('из прочитанных выбирается русский', () => {
    const chosen = authoritativeText([
      text({ locale: 'en' }),
      text({ locale: 'ru' }),
    ]);
    expect(chosen?.locale).toBe('ru');
  });

  it('если русского нет — любой прочитанный', () => {
    expect(authoritativeText([text({ locale: 'en' })])?.locale).toBe('en');
  });
});

describe('что отдавать на локали (§6.7)', () => {
  it('готовый текст отдаётся как есть', () => {
    const d = serveDecision([text({ locale: 'de', reviewed: false })], 'de');
    expect(d.kind).toBe('ready');
  });

  it('непрочитанный перевод отдаётся наравне с прочитанным', () => {
    // Он переведён с ПРОВЕРЕННОГО источника и уже показывался людям.
    // Прятать его до ревью — вернуться к переводу на лету, то есть
    // платить за то, что уже лежит.
    const d = serveDecision([text({ locale: 'de', reviewed: false })], 'de');
    expect(d).toMatchObject({ kind: 'ready' });
  });

  it('нет текста на локали — переводим с авторитетного', () => {
    expect(serveDecision([text()], 'de')).toEqual({
      kind: 'translate',
      from: text(),
    });
  });

  it('нет ни текста, ни авторитетного — не отдаём ничего', () => {
    const d = serveDecision([text({ locale: 'en', reviewed: false })], 'de');
    expect(d.kind).toBe('none');
  });
});

describe('ключи словаря (§6.7)', () => {
  it('ключ подставляется подписью нужной локали в «ёлочках»', () => {
    // «Ёлочки» не украшение: правило 5 преамбулы велит модели
    // переносить их дословно — человек услышит надпись, которую видит.
    const r = renderUiKeys('Нажмите {{clientSiteWizard.liveButton}}', 'ru');
    expect(r.text).toBe('Нажмите «Живой вход»');
    expect(r.unknown).toEqual([]);
  });

  it('на другой локали подставляется её подпись', () => {
    const r = renderUiKeys('{{clientSiteWizard.undoButton}}', 'de');
    expect(r.unknown).toEqual([]);
    expect(r.text).not.toContain('Отменить');
    expect(r.text.startsWith('«')).toBe(true);
  });

  it('неизвестный ключ называется, а не подставляется наугад', () => {
    // Такое бывает не от злого умысла: кнопку переименовали, ключ в
    // словаре исчез, а запись осталась. Приёмка §9 требует, чтобы это
    // помечалось оператору, а не уезжало в промпт.
    const r = renderUiKeys('Нажмите {{clientSiteWizard.goneButton}}', 'ru');
    expect(r.unknown).toEqual(['clientSiteWizard.goneButton']);
    expect(r.text).toContain('{{clientSiteWizard.goneButton}}');
  });

  it('ключ кириллицей ключом не считается — они латинские', () => {
    expect(uiKeysOf('{{раздел.ключ}}')).toEqual([]);
  });

  it('обычные фигурные скобки ключом не считаются', () => {
    // В тексте бывают шаблоны и формулы; считать их ключами значило бы
    // ломать записи, в которых ключей нет вовсе.
    expect(uiKeysOf('поле {name} и {{n}}')).toEqual([]);
  });

  it('сверка ключей ловит потерянный при переводе ключ', () => {
    const source = 'Нажмите {{clientSiteWizard.liveButton}} и ждите';
    expect(sameUiKeys(source, 'Press {{clientSiteWizard.liveButton}}')).toBe(
      true,
    );
    expect(sameUiKeys(source, 'Press the live login button')).toBe(false);
    expect(sameUiKeys(source, 'Press {{clientSiteWizard.undoButton}}')).toBe(
      false,
    );
  });

  it('ключи находятся во всех трёх полях совета', () => {
    expect(
      textUiKeys(
        text({
          symptom: '{{clientSiteWizard.stepRecord}}',
          cause: null,
          advice: '{{clientSiteWizard.undoButton}}',
        }),
      ),
    ).toEqual(['clientSiteWizard.stepRecord', 'clientSiteWizard.undoButton']);
  });

  it('список разрешённых ключей не пуст и знает про кнопки шагов', () => {
    expect(isKnownUiKey('clientSiteWizard.liveButton')).toBe(true);
    expect(isKnownUiKey('clientSiteWizard.goneButton')).toBe(false);
  });
});

describe('строка среза', () => {
  it('три поля собираются в одну реплику', () => {
    expect(experienceLine(text())).toBe(
      'код не приходит; причина: активная сессия Telegram; что делать: смотрите в приложении',
    );
  });

  it('пустая причина не оставляет пустого куска', () => {
    // «Мы знаем, что так бывает» — тоже знание, и причина может быть
    // неизвестна.
    expect(experienceLine(text({ cause: null }))).toBe(
      'код не приходит; что делать: смотрите в приложении',
    );
  });
});
