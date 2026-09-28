import {
  DEFAULT_TUTORIAL_LOCALES,
  parseTutorialLocales,
  serializeTutorialLocales,
  TUTORIAL_LOCALES_SETTING_KEY,
} from './tutorial-locales';

describe('parseTutorialLocales', () => {
  it('ключ настройки — тот, что назван в ТЗ', () => {
    expect(TUTORIAL_LOCALES_SETTING_KEY).toBe('tutorial.scenarioLocales');
  });

  it('ничего не задано — только русский, как до этапа C', () => {
    // Деплой этапа не должен сам по себе учетверить ночной расход.
    expect(parseTutorialLocales(null)).toEqual(['ru']);
    expect(parseTutorialLocales('')).toEqual(['ru']);
    expect(parseTutorialLocales('   ')).toEqual(['ru']);
    expect(DEFAULT_TUTORIAL_LOCALES).toEqual(['ru']);
  });

  it('JSON-массив — основная форма', () => {
    expect(parseTutorialLocales('["ru","en","de"]')).toEqual([
      'ru',
      'en',
      'de',
    ]);
  });

  it('объект с полем locales — как у каталога музыки', () => {
    expect(parseTutorialLocales('{"locales":["uk","es"]}')).toEqual([
      'uk',
      'es',
    ]);
  });

  it('список через запятую — то, что оператор пишет руками чаще JSON', () => {
    expect(parseTutorialLocales('ru, en ,DE')).toEqual(['ru', 'en', 'de']);
  });

  it('порядок сохраняется, дубли схлопываются — побеждает первый', () => {
    expect(parseTutorialLocales('["en","ru","en"]')).toEqual(['en', 'ru']);
  });

  it('негодный код отбрасывается, годные остаются', () => {
    // Разбор терпимый, как у `parseMusicCatalog`: опечатка в пятой
    // локали не должна отключать четыре рабочих. Это осознанно ДРУГОЕ
    // правило, чем у `parseScenarioSteps`, где порядок шагов значим.
    expect(parseTutorialLocales('["ru","fr","en",""]')).toEqual(['ru', 'en']);
  });

  it('ни одного годного кода — умолчание, а не пустота', () => {
    // `["fr"]` — опечатка оператора, а не команда «ничего не
    // генерировать»: пустой список остановил бы генерацию молча.
    expect(parseTutorialLocales('["fr"]')).toEqual(['ru']);
    expect(parseTutorialLocales('[]')).toEqual(['ru']);
  });

  it('сломанный JSON — умолчание, а не пустота и не исключение', () => {
    expect(parseTutorialLocales('["ru",')).toEqual(['ru']);
    expect(parseTutorialLocales('{"locales":"ru"}')).toEqual(['ru']);
  });

  it('элементы не-строки пропускаются, а не роняют разбор', () => {
    expect(parseTutorialLocales('["ru",42,null,"en"]')).toEqual(['ru', 'en']);
  });

  it('пять локалей — потолок, больше их не бывает', () => {
    expect(parseTutorialLocales('["ru","uk","en","de","es"]')).toHaveLength(5);
  });

  it('запись — канонический JSON, каким бы ни был ввод', () => {
    expect(serializeTutorialLocales(parseTutorialLocales('en,ru'))).toBe(
      '["en","ru"]',
    );
  });
});
