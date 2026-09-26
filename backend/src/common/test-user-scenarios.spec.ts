import {
  FREE_SCENARIOS,
  isSpendFree,
  testAccessActive,
  normalizeFreeScenarios,
  scenarioOfProjectType,
  unknownScenarios,
} from './test-user-scenarios';

describe('test-user-scenarios', () => {
  it('первый и второй типы проекта — один сценарий', () => {
    // Решение владельца продукта: обычный проект и линейка тестируются
    // вместе и одним путём, различать их в чекбоксах незачем.
    expect(scenarioOfProjectType('SINGLE')).toBe('PRODUCT_VIDEO');
    expect(scenarioOfProjectType('LINE')).toBe('PRODUCT_VIDEO');
  });

  it('остальные типы разведены по своим сценариям', () => {
    expect(scenarioOfProjectType('CLIENT_SITE')).toBe('CLIENT_SITE');
    expect(scenarioOfProjectType('GREETING_VIDEO')).toBe('GREETING_VIDEO');
  });

  it('неизвестный тип проекта не получает сценария', () => {
    // Новый тип, добавленный в схему позже этого файла, не должен
    // молча стать бесплатным. Забыть дописать его сюда безопасно.
    expect(scenarioOfProjectType('QUANTUM_HOLOGRAM')).toBeNull();
    expect(scenarioOfProjectType(null)).toBeNull();
    expect(scenarioOfProjectType(undefined)).toBeNull();
  });

  it('галочки без флага тестового пользователя не действуют', () => {
    // Снятый флаг не должен оставлять позади невидимое разрешение.
    expect(
      isSpendFree(
        { isTestUser: false, freeScenarios: ['GREETING_VIDEO'] },
        'GREETING_VIDEO',
      ),
    ).toBe(false);
  });

  it('отмеченный сценарий снимает потолок, неотмеченный — нет', () => {
    const access = {
      isTestUser: true,
      freeScenarios: ['GREETING_VIDEO'] as string[],
    };
    expect(isSpendFree(access, 'GREETING_VIDEO')).toBe(true);
    expect(isSpendFree(access, 'PRODUCT_VIDEO')).toBe(false);
    expect(isSpendFree(access, 'CLIENT_SITE')).toBe(false);
  });

  it('операция вне сценария — по своей галочке, а не по трём другим', () => {
    // Клон голоса, озвучка, скетч, поиск на YouTube не принадлежат
    // проекту. До этапа 159 условием было «все три»: вывод верный, но
    // тестировщику одного сценария он означал, что половина его работы
    // идёт за его счёт, и узнавал он об этом в середине прогона.
    const one = { isTestUser: true, freeScenarios: ['GREETING_VIDEO'] };
    const all = { isTestUser: true, freeScenarios: [...FREE_SCENARIOS] };
    expect(isSpendFree(one, 'OUTSIDE_PROJECT')).toBe(false);
    // Три галочки САМИ ПО СЕБЕ больше ничего не открывают: условие
    // стало явным выбором оператора, а не следствием.
    expect(isSpendFree(all, 'OUTSIDE_PROJECT')).toBe(false);
    expect(
      isSpendFree({ ...one, freeOutsideProject: true }, 'OUTSIDE_PROJECT'),
    ).toBe(true);
  });

  it('галочка «вне проекта» работает и без единого сценария', () => {
    // Человек, которому дали только её (проверяет клон голоса), должен
    // ею пользоваться — это самостоятельное разрешение.
    expect(
      isSpendFree(
        { isTestUser: true, freeScenarios: [], freeOutsideProject: true },
        'OUTSIDE_PROJECT',
      ),
    ).toBe(true);
    // Но на сценарий она не распространяется: участок остаётся
    // участком.
    expect(
      isSpendFree(
        { isTestUser: true, freeScenarios: [], freeOutsideProject: true },
        'PRODUCT_VIDEO',
      ),
    ).toBe(false);
  });

  it('проект неизвестного типа не бесплатен даже с галочкой «вне проекта»', () => {
    // «Забыть добавить новый тип в `scenarioOfProjectType` безопасно» —
    // свойство, записанное там же, и галочка «вне проекта» не имеет
    // права его отменять (аудит этапа 159). Проект ЕСТЬ — значит это не
    // операция вне проекта, а тип, о котором код ещё не знает.
    const access = {
      isTestUser: true,
      freeScenarios: [...FREE_SCENARIOS],
      freeOutsideProject: true,
    };
    expect(isSpendFree(access, 'UNKNOWN_PROJECT')).toBe(false);
    expect(isSpendFree(access, 'OUTSIDE_PROJECT')).toBe(true);
  });

  it('срок гасит доступ сам, сколько бы галочек ни стояло', () => {
    // Договорённость с тестировщиком срочная (§4.2 ТЗ), а строка
    // остаётся — по ней потом видно, что он тестировал.
    const now = new Date('2026-09-26T12:00:00.000Z');
    const access = {
      isTestUser: true,
      freeScenarios: [...FREE_SCENARIOS],
      freeOutsideProject: true,
      testAccessUntil: new Date(now.getTime() - 1),
    };
    expect(isSpendFree(access, 'PRODUCT_VIDEO', now)).toBe(false);
    expect(isSpendFree(access, 'OUTSIDE_PROJECT', now)).toBe(false);
    expect(testAccessActive(access, now)).toBe(false);
  });

  it('срок ещё не вышел или его нет вовсе — доступ действует', () => {
    const now = new Date('2026-09-26T12:00:00.000Z');
    const base = { isTestUser: true, freeScenarios: ['PRODUCT_VIDEO'] };
    expect(
      isSpendFree(
        { ...base, testAccessUntil: new Date(now.getTime() + 1) },
        'PRODUCT_VIDEO',
        now,
      ),
    ).toBe(true);
    expect(
      isSpendFree({ ...base, testAccessUntil: null }, 'PRODUCT_VIDEO', now),
    ).toBe(true);
    expect(isSpendFree(base, 'PRODUCT_VIDEO', now)).toBe(true);
  });

  it('не тестовому аккаунту срок ничего не открывает', () => {
    expect(
      testAccessActive({ isTestUser: false, freeScenarios: [] }, new Date()),
    ).toBe(false);
  });

  it('пустой список галочек не даёт ничего даже тестовому', () => {
    expect(
      isSpendFree({ isTestUser: true, freeScenarios: [] }, 'OUTSIDE_PROJECT'),
    ).toBe(false);
    expect(
      isSpendFree({ isTestUser: true, freeScenarios: [] }, 'PRODUCT_VIDEO'),
    ).toBe(false);
  });

  it('мусор в колонке не открывает доступ и не ломает разбор', () => {
    // Колонка — массив строк, а не enum: значение может приехать из
    // psql мимо формы.
    expect(normalizeFreeScenarios(['PRODUCT_VIDEO', 'PRODUCT_VIDEO'])).toEqual([
      'PRODUCT_VIDEO',
    ]);
    expect(normalizeFreeScenarios(['nonsense'])).toEqual([]);
    expect(normalizeFreeScenarios('PRODUCT_VIDEO')).toEqual([]);
    expect(
      isSpendFree(
        { isTestUser: true, freeScenarios: ['nonsense'] },
        'OUTSIDE_PROJECT',
      ),
    ).toBe(false);
  });

  it('порядок в списке не зависит от порядка ввода', () => {
    expect(normalizeFreeScenarios(['GREETING_VIDEO', 'PRODUCT_VIDEO'])).toEqual(
      ['PRODUCT_VIDEO', 'GREETING_VIDEO'],
    );
  });

  it('неизвестные значения называются поимённо — форме есть что сказать', () => {
    expect(unknownScenarios(['PRODUCT_VIDEO', 'VIDEO', 'VIDEO'])).toEqual([
      'VIDEO',
    ]);
    expect(unknownScenarios([...FREE_SCENARIOS])).toEqual([]);
  });
});
