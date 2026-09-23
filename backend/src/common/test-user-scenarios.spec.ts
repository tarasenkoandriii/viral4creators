import {
  FREE_SCENARIOS,
  isSpendFree,
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

  it('операция вне сценария бесплатна только при всех галочках', () => {
    // Клон голоса, озвучка, скетч, поиск на YouTube не принадлежат
    // проекту. «Хотя бы один» означало бы, что галочка на поздравления
    // открывает бесплатный поиск референсов для товарки.
    const one = { isTestUser: true, freeScenarios: ['GREETING_VIDEO'] };
    const all = { isTestUser: true, freeScenarios: [...FREE_SCENARIOS] };
    expect(isSpendFree(one, null)).toBe(false);
    expect(isSpendFree(all, null)).toBe(true);
  });

  it('пустой список галочек не даёт ничего даже тестовому', () => {
    expect(isSpendFree({ isTestUser: true, freeScenarios: [] }, null)).toBe(
      false,
    );
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
      isSpendFree({ isTestUser: true, freeScenarios: ['nonsense'] }, null),
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
