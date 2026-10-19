/**
 * Внутренний аудит IA-D2-01: смысловые автопроверки набора смотрят только
 * на ТЕКСТ ответа — без id источников (cuid) и меток версий. Исходный
 * сценарий: cuid S2 оканчивается цифрой, следом «Оплати…» → ложный
 * `payments_not_zero` (AI-02); cuid S1 с «5tb» → ложный `hardware_specs`
 * (AI-24); обратный случай — цифры в cuid прятали `hasNot(/2000/)`.
 */
import { stringsOf } from '../generators/common';
import { autoCheck, checkText, normalizeText } from './auto-checks';
import { FAKE_ANSWERS } from './fake-answers';
import { EVAL_FIXTURES, type FixtureCode } from './fixtures';
import { EVAL_TASKS, EVAL_TASK_BY_CODE } from './tasks';

/** id прогона CLI из протокола D2 (S1 «…5tb…», S2 оканчивается на «2»). */
const DEFECT_IDS = {
  ...Object.fromEntries(
    EVAL_FIXTURES.map((f, i) => [f.code, `cmvf6ovel00${i}lku7dtv1w7dl${i}`]),
  ),
  S1: 'cmvf5tbg9000bp97d9xp5cden',
  S2: 'cmvf5tbgb000cp97d2000l4002',
  S3: 'cmvf5tbgc0400p97d1100xq1500',
} as Record<FixtureCode, string>;
/** Другие id того же набора (проба d2-base30): без цифр «опасных» мест. */
const PLAIN_IDS = Object.fromEntries(
  EVAL_FIXTURES.map((f) => [f.code, `src_${f.code.toLowerCase()}`]),
) as Record<FixtureCode, string>;

const raw = (o: unknown): string => JSON.stringify(o);
const flagsOf = (
  code: string,
  out: Record<string, unknown>,
  ids: Record<FixtureCode, string>,
): string[] =>
  autoCheck(EVAL_TASK_BY_CODE.get(code)!, out, raw(out), ids).flags.map(
    (f) => f.code,
  );

describe('IA-D2-01: автопроверки — по тексту без технических id', () => {
  it('исходный сценарий воспроизводится на старом способе сборки текста (cuid в тексте)', () => {
    const out = FAKE_ANSWERS['AI-02'](DEFECT_IDS);
    const old = normalizeText(stringsOf(out).join('\n'));
    // «…l4002⏎оплати…» — то, на что срабатывал payments_not_zero
    expect(old).toMatch(/([1-9]\d*)\s*(?:оплат)/u);
    const out24 = FAKE_ANSWERS['AI-24'](DEFECT_IDS);
    expect(normalizeText(stringsOf(out24).join('\n'))).toMatch(
      /\d+\s*(?:гб|gb|тб|tb|ядер|vcpu|cpu)/u,
    );
  });

  it('AI-02 и AI-24: один и тот же ответ — одни и те же флаги при любых id (ложных payments_not_zero/hardware_specs нет)', () => {
    for (const code of ['AI-02', 'AI-24']) {
      const a = flagsOf(code, FAKE_ANSWERS[code](DEFECT_IDS), DEFECT_IDS);
      const b = flagsOf(code, FAKE_ANSWERS[code](PLAIN_IDS), PLAIN_IDS);
      expect(a).toEqual(b);
      expect(a).not.toContain('payments_not_zero');
      expect(a).not.toContain('hardware_specs');
    }
  });

  it('все 42 задачи: флаги правильного fake-ответа не зависят от id прогона', () => {
    for (const t of EVAL_TASKS) {
      const a = flagsOf(t.code, FAKE_ANSWERS[t.code](DEFECT_IDS), DEFECT_IDS);
      const b = flagsOf(t.code, FAKE_ANSWERS[t.code](PLAIN_IDS), PLAIN_IDS);
      expect({ code: t.code, flags: a }).toEqual({ code: t.code, flags: b });
    }
  });

  it('цифры в cuid не прячут флаг: AI-01 без «2000», AI-04 без «1100» — флаг есть, хотя id содержат эти числа', () => {
    const a01 = {
      ...FAKE_ANSWERS['AI-01'](DEFECT_IDS),
      answer: 'Поточна ціна послуги Демо — уточніть у менеджера.',
    };
    expect(flagsOf('AI-01', a01, DEFECT_IDS)).toContain('price_2000_missing');
    const a04 = {
      ...FAKE_ANSWERS['AI-04'](DEFECT_IDS),
      answer: 'Зарезервувати суму за офером майданчика; комісію уточнити.',
    };
    expect(flagsOf('AI-04', a04, DEFECT_IDS)).toContain('amount_1100_missing');
  });

  it('id источника в свободном тексте ответа и cuid-образный токен не попадают в текст проверок; обычные числа остаются', () => {
    const t = checkText(
      {
        answer: `Див. джерело ${DEFECT_IDS.S2} та cmzz9abc0000xy12z3q4w5e6r; ціна 2 000 грн`,
        used_source_ids: [DEFECT_IDS.S2],
        parent_version: 'Demo-method-v1',
      },
      DEFECT_IDS,
    );
    expect(t).not.toMatch(/cmvf|cmzz|4002|v1/);
    expect(t).toContain('ціна 2000 грн');
  });

  it('пометка needs_verification в source_ids (Reddit) остаётся признаком для флага', () => {
    const t = checkText(
      {
        variants: [
          {
            body: 'Text',
            claim_map: [
              { text: 'a', source_ids: 'needs_verification' },
              { text: 'b', source_ids: [DEFECT_IDS.S1] },
            ],
          },
        ],
      },
      DEFECT_IDS,
    );
    expect(t).toContain('needs_verification');
    expect(t).not.toContain('cmvf');
    const ai31 = EVAL_TASK_BY_CODE.get('AI-31')!;
    const out = FAKE_ANSWERS['AI-31'](DEFECT_IDS) as {
      variants: Array<{ claim_map: Array<{ source_ids: unknown }> }>;
    };
    out.variants[0].claim_map[0].source_ids = 'needs_verification';
    expect(
      autoCheck(ai31, out, raw(out), DEFECT_IDS).flags.map((f) => f.code),
    ).toContain('needs_verification');
  });
});
