import {
  NO_PRODUCT_ROLES,
  OWNER_PRODUCT_ROLES,
  REQUIRE_ASSIST_ANY,
  REQUIRE_PUBLISHER_ADMIN,
  REQUIRE_PUBLISHER_ANY,
  parseProductRoles,
  satisfiesProductRoles,
  validateProductRolesInput,
} from './roles';

/**
 * AI Publisher (P-A0, проектный документ §4.1): допуск к продукту —
 * `productRoles.publisher: admin|member|none`. Права `assist`/`qa` к
 * Publisher не дают ничего; владелец кабинета — `admin`.
 */
describe('productRoles.publisher', () => {
  const op = (productRoles: Record<string, unknown>) => ({
    role: 'operator' as const,
    productRoles: parseProductRoles(productRoles),
  });

  it('разбор: admin/member сохраняются; none, мусор и отсутствие — нет ключа (= none)', () => {
    expect(parseProductRoles({ publisher: 'admin' }).publisher).toBe('admin');
    expect(parseProductRoles({ publisher: 'member' }).publisher).toBe('member');
    for (const v of ['none', 'owner', 'ADMIN', 1, null, undefined]) {
      expect(parseProductRoles({ publisher: v })).toEqual(NO_PRODUCT_ROLES);
    }
    // Прежние строки базы и ответы API не меняют форму.
    expect(parseProductRoles({ assist: 'operator' })).toEqual({
      qa: 'none',
      assist: 'operator',
      assistAdmin: 'none',
    });
  });

  it('владелец кабинета — publisher=admin; умолчание остальных — none', () => {
    expect(OWNER_PRODUCT_ROLES.publisher).toBe('admin');
    expect(NO_PRODUCT_ROLES.publisher).toBeUndefined();
  });

  it('вход приглашения/правки: допустимые значения, опечатка — отказ', () => {
    expect(validateProductRolesInput({ publisher: 'member' })).toMatchObject({
      publisher: 'member',
    });
    expect(validateProductRolesInput({ publisher: 'superadmin' })).toBeNull();
    expect(validateProductRolesInput({ publisher: 'none' })).toEqual(
      NO_PRODUCT_ROLES,
    );
  });

  it('требования маршрутов: any — admin|member, admin — только admin', () => {
    expect(
      satisfiesProductRoles(op({ publisher: 'member' }), REQUIRE_PUBLISHER_ANY),
    ).toBe(true);
    expect(
      satisfiesProductRoles(op({ publisher: 'admin' }), REQUIRE_PUBLISHER_ANY),
    ).toBe(true);
    expect(
      satisfiesProductRoles(
        op({ publisher: 'member' }),
        REQUIRE_PUBLISHER_ADMIN,
      ),
    ).toBe(false);
    expect(
      satisfiesProductRoles(
        op({ publisher: 'admin' }),
        REQUIRE_PUBLISHER_ADMIN,
      ),
    ).toBe(true);
    expect(satisfiesProductRoles(op({}), REQUIRE_PUBLISHER_ANY)).toBe(false);
  });

  it('права помощника и QA к Publisher ничего не дают', () => {
    const allButPublisher = op({
      qa: 'admin',
      assist: 'manager',
      assistAdmin: 'owner',
    });
    expect(satisfiesProductRoles(allButPublisher, REQUIRE_PUBLISHER_ANY)).toBe(
      false,
    );
    // …и наоборот: publisher=admin не открывает помощник.
    expect(
      satisfiesProductRoles(op({ publisher: 'admin' }), REQUIRE_ASSIST_ANY),
    ).toBe(false);
  });

  it('владелец кабинета проходит любое требование Publisher, даже без ключа в строке', () => {
    expect(
      satisfiesProductRoles(
        { role: 'owner', productRoles: NO_PRODUCT_ROLES },
        REQUIRE_PUBLISHER_ADMIN,
      ),
    ).toBe(true);
  });
});
