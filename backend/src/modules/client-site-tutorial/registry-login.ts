/**
 * Вход учёткой из реестра сайта (Э-С Ш2-хвост (3)): как черновик помнит,
 * ЧЕМ он входил, не копируя пароль.
 *
 * Учётку заводят руками в кабинете (логин + пароль, без селекторов). Вход
 * ею — раунд, где генератор берёт пароль арендой и сам находит поля формы
 * (`login-form-detect.ts`). Переигровке (`/undo`) нужно знать «в какое поле
 * что вводилось» — в поля входа черновика (`login-fields` его записи
 * хранилища) пишется не значение, а ССЫЛКА на учётку реестра:
 *
 *   { selector: '#password', value: '\u0000registry:<id>:password' }
 *
 * и при каждом чтении она заново разрешается арендой учётки. Так:
 *  - пароль не дублируется в запись черновика (одно место, один журнал);
 *  - владелец меняет пароль в кабинете — черновик входит новым;
 *  - учётку заморозили, удалили, сняли продукт или хост — аренда
 *    отказывает, поле выпадает, переигровка честно просит войти заново;
 *  - удаление черновика или «одноразово» стирают только ссылку — учётку
 *    реестра (чужую для черновика) они не трогают.
 *
 * Префикс с NUL — значение, которое человек не введёт в форму руками; ввод
 * такого значения через `/login` отклоняется (иначе подделанная ссылка
 * разрешилась бы чужой учёткой).
 */
import { UnprocessableEntityException } from '@nestjs/common';
import {
  LOGIN_FIELDS_NOT_FOUND,
  type LoginFieldKind,
} from './login-form-detect';

export const REGISTRY_REF_PREFIX = '\u0000registry:';
const REF_RE = /^\u0000registry:([A-Za-z0-9_-]{1,64}):(username|password)$/;

export type RegistryRefPart = 'username' | 'password';

export function registryRef(testAccountId: string, part: RegistryRefPart) {
  return `${REGISTRY_REF_PREFIX}${testAccountId}:${part}`;
}

export function parseRegistryRef(
  value: string,
): { testAccountId: string; part: RegistryRefPart } | null {
  const m = REF_RE.exec(value);
  return m ? { testAccountId: m[1], part: m[2] as RegistryRefPart } : null;
}

/** Похоже на ссылку реестра (в т.ч. кривую) — из ввода человека не принимается. */
export function looksLikeRegistryRef(value: string): boolean {
  return value.startsWith(REGISTRY_REF_PREFIX);
}

/** 422: на странице не нашлось полей входа (или указанные — не те). */
export class LoginFieldsNotFoundError extends UnprocessableEntityException {
  constructor(readonly missing: LoginFieldKind[]) {
    super({
      error: LOGIN_FIELDS_NOT_FOUND,
      code: LOGIN_FIELDS_NOT_FOUND,
      message:
        'не нашли поля входа на этой странице — укажите поле логина, пароля и кнопку входа вручную',
      // `reason` проходит фильтром ответа: чего именно не хватило.
      reason: missing.join(','),
    });
  }
}
