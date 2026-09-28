/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
import { BadRequestException } from '@nestjs/common';
import { AdminTutorialLocalesSettingsService } from './admin-tutorial-locales-settings.service';

function build(stored: string | null = null) {
  const settings = {
    get: jest.fn().mockResolvedValue(stored),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const service = new AdminTutorialLocalesSettingsService(settings as any);
  return { service, settings };
}

describe('AdminTutorialLocalesSettingsService', () => {
  it('ничего не задано — умолчание без всяких «отброшено»', async () => {
    const view = await (await build().service).get();

    expect(view).toMatchObject({
      locales: ['ru'],
      submitted: 0,
      accepted: 0,
      rejectedCodes: [],
      fellBackToDefault: false,
    });
  });

  it('все коды годные — приняли столько же, сколько прислали', async () => {
    const { service } = build('["ru","en"]');

    const view = await service.get();

    expect(view).toMatchObject({
      locales: ['ru', 'en'],
      submitted: 2,
      accepted: 2,
      rejectedCodes: [],
    });
  });

  it('единственный негодный код НЕ выглядит принятым', async () => {
    // До правки аудита `rejected` считался как `submitted -
    // locales.length`, а в `locales` при полном отказе лежит
    // подставленный `ru`, которого оператор не присылал: выходило
    // «отброшено 0 из 1», то есть подтверждение того, чего не было.
    const { service } = build('fr');

    const view = await service.get();

    expect(view).toMatchObject({
      submitted: 1,
      accepted: 0,
      rejectedCodes: ['fr'],
      fellBackToDefault: true,
    });
    expect(view.effect).toMatch(/не распознан/);
  });

  it('отброшены оба — оба и названы', async () => {
    const { service } = build('fr,it');

    expect((await service.get()).rejectedCodes).toEqual(['fr', 'it']);
  });

  it('локаль с регионом не проходит — и это видно', async () => {
    // Нормализации `ru-RU → ru` здесь нет намеренно: список локалей
    // продукта — ровно пять кодов, и подставлять за оператора то,
    // чего он не писал, значит скрыть от него опечатку.
    const { service } = build('ru-RU, en-US');

    expect(await service.get()).toMatchObject({
      accepted: 0,
      rejectedCodes: ['ru-RU', 'en-US'],
    });
  });

  it('дубль отбрасывается как дубль, а не как «не поддерживается»', async () => {
    const { service } = build('ru,ru,ru');

    expect(await service.get()).toMatchObject({
      locales: ['ru'],
      submitted: 3,
      accepted: 1,
      rejectedCodes: ['ru', 'ru'],
    });
  });

  it('сломанный JSON виден как отброшенный ввод, а не как пустота', async () => {
    // `submitted: 0` означало бы «оператор ничего не прислал» — он
    // прислал, просто мы не разобрали.
    const { service } = build('["ru",');

    expect(await service.get()).toMatchObject({
      submitted: 1,
      accepted: 0,
      fellBackToDefault: true,
    });
  });

  it('коды через пробел без запятой — один код, и второй честно потерян', async () => {
    // Разделитель ровно один, запятая: витрина обязана показывать то
    // же, что понимает разбор, иначе «принят 1 из 1» соврёт.
    const { service } = build('ru en');

    expect(await service.get()).toMatchObject({ submitted: 1, accepted: 0 });
  });

  it('в базу ложится канонический JSON, а не сырой ввод', async () => {
    const { service, settings } = build();

    await service.set(' EN , ru ', 'op-1');

    expect(settings.set).toHaveBeenCalledWith(
      'tutorial.scenarioLocales',
      '["en","ru"]',
      'op-1',
    );
  });

  it('ответ на запись — витрина по ПРИСЛАННОМУ, чтобы отказ был виден', async () => {
    const { service } = build();

    const view = await service.set('ru,fr', 'op-1');

    expect(view).toMatchObject({
      locales: ['ru'],
      submitted: 2,
      accepted: 1,
      rejectedCodes: ['fr'],
    });
  });

  it('слишком длинный ввод отвергается до записи', async () => {
    const { service, settings } = build();

    await expect(service.set('ru,'.repeat(300), 'op-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('JSON-объект без locales — отвергнут целиком, а не молча', async () => {
    // Своя копия разбора у витрины возвращала пустой список:
    // «прислали 0, отброшено 0», предупреждение не рендерилось, а
    // генератор подставлял умолчание. Оператор видел `ru` и ноль
    // сигналов (находка сквозного аудита A+B+C).
    const { service } = build('{"a":1}');

    expect(await service.get()).toMatchObject({
      locales: ['ru'],
      submitted: 1,
      accepted: 0,
      fellBackToDefault: true,
    });
  });

  it('объект с locales-строкой вместо массива — тоже отказ, а не пустота', async () => {
    const { service } = build('{"locales":"ru"}');

    expect(await service.get()).toMatchObject({
      submitted: 1,
      accepted: 0,
      fellBackToDefault: true,
    });
  });
});
