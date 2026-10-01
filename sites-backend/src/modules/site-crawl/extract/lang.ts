/**
 * Язык страницы без пакета (контракт Э1, решение 10): `<html lang>`, иначе
 * эвристика по буквам. Нужен воротам «смена преобладающего языка базы»
 * (§4-тер.2) и сводке «язык uk/ru» — точность «какой алфавит/язык
 * преобладает», а не лингвистика.
 */

/** `uk-UA` → `uk`; мусор → null. */
export function langFromAttr(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const primary = raw.trim().toLowerCase().split(/[-_]/)[0];
  if (!/^[a-z]{2,3}$/.test(primary)) return null;
  // `ua` — частая ошибка вместо `uk` (код страны вместо кода языка).
  return primary === 'ua' ? 'uk' : primary;
}

/**
 * По тексту: украинские буквы і/ї/є/ґ → uk; русские ы/э/ё/ъ → ru; иначе
 * кириллица без маркеров — по большинству маркеров (или null), латиница —
 * en. Слишком мало букв — null (не угадываем).
 */
export function detectLang(text: string): string | null {
  const sample = text.slice(0, 20_000).toLowerCase();
  let cyr = 0;
  let lat = 0;
  let uk = 0;
  let ru = 0;
  for (const ch of sample) {
    if (ch >= 'а' && ch <= 'я') cyr++;
    else if (ch >= 'a' && ch <= 'z') lat++;
    if (ch === 'і' || ch === 'ї' || ch === 'є' || ch === 'ґ') {
      uk++;
      cyr++;
    } else if (ch === 'ы' || ch === 'э' || ch === 'ъ') {
      ru++;
    } else if (ch === 'ё') {
      ru++;
      cyr++;
    }
  }
  if (cyr + lat < 20) return null;
  if (cyr >= lat) {
    if (uk === 0 && ru === 0) return null;
    return uk >= ru ? 'uk' : 'ru';
  }
  return 'en';
}
