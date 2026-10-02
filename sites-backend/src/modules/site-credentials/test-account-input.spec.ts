import { BadRequestException } from '@nestjs/common';
import { parseTestAccountInput } from './test-account-input';

const ok = {
  label: 'Покупатель Pro',
  role: 'customer',
  plan: 'Pro',
  username: 'qa@example.com',
  password: 's3cret',
  hostIds: ['h1', 'h1', 'h2'],
  products: ['tutorial', 'qa'],
  lifetimeDays: 30,
  confirmedTestAccount: true,
};

function fails(body: unknown, partial = false): boolean {
  try {
    parseTestAccountInput(body, { partial });
    return false;
  } catch (e) {
    return e instanceof BadRequestException;
  }
}

describe('ввод тестовой учётной записи', () => {
  it('создание: всё разобрано, хосты без повторов', () => {
    expect(parseTestAccountInput(ok, { partial: false })).toEqual({
      ...ok,
      hostIds: ['h1', 'h2'],
    });
  });

  it('создание без подписи, хостов или продуктов — 400', () => {
    expect(fails({ ...ok, label: undefined })).toBe(true);
    expect(fails({ ...ok, hostIds: [] })).toBe(true);
    expect(fails({ ...ok, products: undefined })).toBe(true);
  });

  it('лишнее поле, чужой продукт, кривой срок, управляющие символы — 400', () => {
    expect(fails({ ...ok, secret: 'x' })).toBe(true);
    expect(fails({ ...ok, products: ['assist'] })).toBe(true);
    expect(fails({ ...ok, lifetimeDays: 365 })).toBe(true);
    expect(fails({ ...ok, label: 'a\u0007b' })).toBe(true);
    expect(fails({ ...ok, hostIds: ['../x'] })).toBe(true);
    expect(fails({ ...ok, password: 'x'.repeat(1025) })).toBe(true);
    expect(fails({ ...ok, status: 'expired' }, true)).toBe(true);
  });

  it('правка: всё необязательно, пустая роль — null, пустой список хостов — 400', () => {
    expect(parseTestAccountInput({ role: '' }, { partial: true })).toEqual({
      role: null,
    });
    expect(fails({ hostIds: [] }, true)).toBe(true);
    expect(parseTestAccountInput({}, { partial: true })).toEqual({});
  });
});
