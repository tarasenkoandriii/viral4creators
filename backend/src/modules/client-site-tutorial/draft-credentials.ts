/**
 * Тестовые учётные данные заказчика внутри черновика — §7.3 ТЗ
 * (doc/CLIENT-SITE-TUTORIAL-SPEC.md), этап 111.
 *
 * ## Почему это отдельный модуль, а не «положим в тот же cookie jar»
 *
 * Соблазн был: `cookie-jar.ts` рядом уже умеет «зашифровать список
 * объектов», и пару `{селектор, значение}` можно уложить в поля куки.
 * Так делать нельзя по двум причинам, и обе проявились бы не сразу.
 *
 * 1. Куки и креды живут по РАЗНЫМ правилам. `parseCookieJar()` по
 *    построению выбрасывает всё, что выглядит просроченным или кривым —
 *    это правильно для кук (одна битая кука не должна ронять раунд) и
 *    категорически неправильно для кред: молча потерянный пароль
 *    означает, что пересборка ролика (§7.3) войдёт в сайт «наполовину»
 *    и запишет видео с экраном ошибки. Здесь потеря — это исключение, а
 *    не счётчик `dropped`.
 * 2. Читающий базу человек увидел бы пароль в поле `value` объекта,
 *    который во всём остальном выглядит как кука, с доменом вида
 *    `https://shop.example.com` (для куки это вообще не домен). Формат
 *    хранения обязан говорить, что в нём лежит.
 *
 * Шифрование — общий `token-crypto.ts` (AES-256-GCM), как у OAuth-токенов
 * каналов и `recToken` платежей, но СВОИМ ключом `SITE_TUTORIAL_TOKEN_KEY`:
 * компрометация одного ключа не должна открывать секреты другой
 * чувствительности.
 */

import { decryptToken, encryptToken } from '../../common/token-crypto';

export interface DraftCredentialField {
  /** Селектор поля на странице заказчика — по нему значение
   * подставляется при пересборке (§7.3). */
  selector: string;
  value: string;
}

/**
 * Потолок на весь набор кред. 16 КБ — это заведомо больше любой честной
 * формы входа (двадцать полей по 4096 символов ТЗ ограничивает уже на
 * уровне DTO) и заведомо меньше, чем нужно, чтобы через это поле
 * протащить в базу файл. Превышение — ошибка, а НЕ обрезание: обрезанный
 * пароль хуже отсутствующего, он выглядит сохранённым.
 */
export const MAX_CREDENTIALS_BYTES = 16 * 1024;

export class CredentialsTooLargeError extends Error {}
export class CredentialsCorruptedError extends Error {}

export function encryptCredentials(
  fields: DraftCredentialField[],
  key: string,
): string {
  const json = JSON.stringify(
    fields.map((f) => ({ selector: f.selector, value: f.value })),
  );
  const size = Buffer.byteLength(json, 'utf8');
  if (size > MAX_CREDENTIALS_BYTES) {
    throw new CredentialsTooLargeError(
      `учётные данные не помещаются в ${MAX_CREDENTIALS_BYTES} байт (получилось ${size})`,
    );
  }
  return encryptToken(json, key);
}

/**
 * Разбор недоверенного входа: строку мог записать более старый код, а
 * ключ мог быть заменён. В отличие от cookie jar, частичный результат
 * здесь не возвращается — либо полный набор, либо исключение.
 */
export function decryptCredentials(
  stored: string,
  key: string,
): DraftCredentialField[] {
  let raw: unknown;
  try {
    raw = JSON.parse(decryptToken(stored, key));
  } catch (err) {
    throw new CredentialsCorruptedError(
      `учётные данные черновика не читаются: ${(err as Error).message}`,
    );
  }
  if (!Array.isArray(raw)) {
    throw new CredentialsCorruptedError(
      'учётные данные черновика не читаются: ожидался список полей',
    );
  }
  return raw.map((item, index) => {
    const f = item as Record<string, unknown>;
    if (
      typeof f?.selector !== 'string' ||
      f.selector.length === 0 ||
      typeof f?.value !== 'string'
    ) {
      throw new CredentialsCorruptedError(
        `учётные данные черновика не читаются: поле №${index + 1} повреждено`,
      );
    }
    return { selector: f.selector, value: f.value };
  });
}
