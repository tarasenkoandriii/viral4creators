/**
 * Шов между таблицей вердиктов (`src/lib/compare-verdicts.ts`) и
 * строками сравнения в пяти словарях (этап C ТЗ
 * `docs-tz/TZ-Enterprise-Tutorial-Landing.md`).
 *
 * Знак «есть»/«нет» стоит рядом со строкой по НОМЕРУ, а не по смыслу
 * текста: вердикт — факт о продукте, одинаковый во всех локалях, и
 * держать его в пяти json значило бы ждать, пока они разойдутся. Цена
 * такого решения — порядок строк становится несущим. Этот тест её и
 * оплачивает.
 *
 * Проверяются три вещи, и третья — главная.
 *
 *  1. Длина таблицы вердиктов равна числу строк в КАЖДОЙ локали.
 *  2. Число строк одинаково во всех локалях (иначе п.1 прошёл бы на
 *     русском и молча соврал на немецком).
 *  3. Вердикт согласован с текстом ячейки: `'yes'` — ячейка начинается
 *     со слова «да» этого языка, `'no'` — со слова «нет», `'none'` — ни
 *     с того ни с другого. Именно эта проверка ловит подмену смысла при
 *     переводе или перестановке строк — то, ради чего тест написан.
 *     Список слов ниже хрупок намеренно: если формулировку в словаре
 *     поменяют, тест обязан упасть громко, а не тихо разрешить знаку
 *     «нет» встать рядом со словом «Так».
 */
import assert from 'node:assert/strict';
import { getDictionary } from '../src/lib/get-dictionary';
import { locales, type Locale } from '../src/lib/i18n';
import { COMPARE_VERDICTS, type Verdict } from '../src/lib/compare-verdicts';

/** Ведущее слово ячейки на каждом языке. Только «да» и «нет»: всё
 *  остальное («обычно», «чаще», «más a menudo») — оговорка о категории,
 *  у которой вердикта нет по построению. */
const WORDS: Record<Locale, { yes: string[]; no: string[] }> = {
  ru: { yes: ['да'], no: ['нет'] },
  uk: { yes: ['так'], no: ['ні'] },
  en: { yes: ['yes'], no: ['no'] },
  de: { yes: ['ja'], no: ['nein'] },
  es: { yes: ['sí', 'si'], no: ['no'] },
};

/** Первое слово ячейки в нижнем регистре, без хвостовой пунктуации. */
function leadWord(cell: string): string {
  return (cell.trim().split(/[\s,—–-]+/)[0] ?? '').toLowerCase();
}

function verdictOfText(cell: string, locale: Locale): Verdict {
  const w = leadWord(cell);
  if (WORDS[locale].yes.includes(w)) return 'yes';
  if (WORDS[locale].no.includes(w)) return 'no';
  return 'none';
}

let checked = 0;
let rowsInRu = 0;

for (const locale of locales) {
  const rows = getDictionary(locale).siteTutorialLanding.compare.rows;

  assert.equal(
    rows.length,
    COMPARE_VERDICTS.length,
    `${locale}: строк в словаре ${rows.length}, вердиктов ${COMPARE_VERDICTS.length} — знаки встанут не у тех строк`,
  );

  if (locale === 'ru') rowsInRu = rows.length;
  assert.equal(
    rows.length,
    rowsInRu,
    `${locale}: число строк сравнения разошлось с русским словарём`,
  );

  rows.forEach((row, i) => {
    assert.equal(
      verdictOfText(row.us, locale),
      COMPARE_VERDICTS[i].us,
      `${locale}, строка ${i + 1}, колонка «у нас»: текст «${row.us}» не сходится с вердиктом «${COMPARE_VERDICTS[i].us}»`,
    );
    assert.equal(
      verdictOfText(row.them, locale),
      COMPARE_VERDICTS[i].them,
      `${locale}, строка ${i + 1}, колонка «у них»: текст «${row.them}» не сходится с вердиктом «${COMPARE_VERDICTS[i].them}»`,
    );
    checked += 2;
  });
}

/** Обе строки, где мы проигрываем, обязаны остаться в таблице: без них
 *  она превращается в рекламу, против чего прямо написан компонент. */
const ourNo = COMPARE_VERDICTS.filter((v) => v.us === 'no').length;
assert.ok(
  ourNo >= 2,
  `в таблице должно оставаться не меньше двух строк, где у нас «нет»; сейчас ${ourNo}`,
);

console.log(
  `compare-verdicts: ok (${checked} ячеек × вердикт, ${locales.length} локалей, наших «нет» — ${ourNo})`,
);
