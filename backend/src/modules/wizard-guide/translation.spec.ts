/**
 * Перевод записи опыта — «Тонкая красная линия» §6.7, этап 11.
 *
 * Главная проверка здесь одна: перевод, потерявший ключ словаря, не
 * сохраняется. Без неё правило «не называть кнопки словами» держится на
 * честном слове модели, а ошибка ЗАМОРАЖИВАЕТСЯ в базе и живёт, пока её
 * не прочитают.
 */

import { buildTranslationPrompt, parseTranslation } from './translation';

const source = {
  symptom: 'Код не приходит',
  cause: 'активная сессия',
  advice: 'нажмите {{clientSiteWizard.liveRestartButton}}',
};

describe('разбор перевода (§6.7)', () => {
  it('нормальный перевод читается', () => {
    const r = parseTranslation(
      '{"symptom":"Code kommt nicht","cause":"aktive Sitzung","advice":"drücken Sie {{clientSiteWizard.liveRestartButton}}"}',
      source,
    );
    expect(r.text).toEqual({
      symptom: 'Code kommt nicht',
      cause: 'aktive Sitzung',
      advice: 'drücken Sie {{clientSiteWizard.liveRestartButton}}',
    });
  });

  it('потерянный ключ отменяет сохранение', () => {
    const r = parseTranslation(
      '{"symptom":"Code kommt nicht","cause":"","advice":"drücken Sie den Live-Login-Knopf"}',
      source,
    );
    expect(r.text).toBeNull();
    expect(r.reason).toBe('keys-lost');
  });

  it('переведённый ключ — тоже потерянный', () => {
    // Модель однажды «переведёт» и сам ключ; для нас это то же самое,
    // что вписать название кнопки словами.
    const r = parseTranslation(
      '{"symptom":"Code kommt nicht","cause":"","advice":"{{clientSiteWizard.neustartKnopf}}"}',
      source,
    );
    expect(r.reason).toBe('keys-lost');
  });

  it('ключ, переехавший в другое поле, не проходит', () => {
    // Множество ключей совпало, а смысл сломан: совет без кнопки, зато
    // кнопка в симптоме.
    const r = parseTranslation(
      '{"symptom":"{{clientSiteWizard.liveRestartButton}}","cause":"","advice":"drücken"}',
      source,
    );
    expect(r.reason).toBe('keys-lost');
  });

  it('пустой симптом или совет — не перевод', () => {
    expect(
      parseTranslation('{"symptom":"","cause":"","advice":"x"}', {
        symptom: 'a',
        advice: 'b',
      }).reason,
    ).toBe('empty');
  });

  it('пустая причина — законный перевод', () => {
    // «Мы знаем, что так бывает» — тоже знание, причины может не быть.
    const r = parseTranslation('{"symptom":"a","cause":"","advice":"b"}', {
      symptom: 'a',
      advice: 'b',
    });
    expect(r.text).toEqual({ symptom: 'a', cause: null, advice: 'b' });
  });

  it('не-JSON не роняет разбор', () => {
    expect(parseTranslation('вот перевод: ...', source).reason).toBe(
      'not-json',
    );
  });
});

describe('инструкция переводчику', () => {
  it('называет ключи и требует перенести их дословно', () => {
    const p = buildTranslationPrompt('de', source);
    expect(p).toContain('clientSiteWizard.liveRestartButton');
    expect(p).toContain('ДОСЛОВНО');
  });

  it('без ключей про них не говорит', () => {
    const p = buildTranslationPrompt('de', { symptom: 'a', advice: 'b' });
    expect(p).not.toContain('{{');
  });

  it('называет целевой язык словом, а не кодом локали', () => {
    // 'de' модель понимает не всегда однозначно; название языка —
    // всегда.
    const p = buildTranslationPrompt('de', source);
    expect(p).toContain('German');
    expect(p).not.toMatch(/на de\b/);
  });
});
