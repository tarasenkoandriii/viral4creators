/**
 * Первая запись корпуса — «Тонкая красная линия» §6.6.
 *
 * Запись заводится МИГРАЦИЕЙ (`20261215090000_wizard_first_experience`),
 * а её текст живёт в `first-experience.ts`. Два места — два способа
 * разойтись, поэтому здесь они сверяются буква в букву: разойдясь, они
 * дали бы «в базе одно, в репозитории другое» ровно в той записи, на
 * которой принимается весь §6.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { FIRST_EXPERIENCE } from './first-experience';
import { isKnownUiKey, uiKeysOf } from './ui-keys';

const MIGRATION = join(
  __dirname,
  '..',
  '..',
  '..',
  'prisma',
  'migrations',
  '20261215090000_wizard_first_experience',
  'migration.sql',
);

describe('первая запись корпуса (§6.6)', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  it('миграция несёт ровно тот текст, что и код', () => {
    // SQL экранирует одинарные кавычки удвоением — сверяем так же.
    const esc = (s: string) => s.replace(/'/g, "''");
    expect(sql).toContain(esc(FIRST_EXPERIENCE.text.symptom));
    expect(sql).toContain(esc(FIRST_EXPERIENCE.text.cause));
    expect(sql).toContain(esc(FIRST_EXPERIENCE.text.advice));
  });

  it('заводится черновиком, а не опубликованной', () => {
    // Причину подтверждает владелец (§15 п.1): объяснение, которое
    // потом цитирует модель тысяче людей, не должно опираться на
    // реконструкцию по коду.
    expect(sql).toContain("'DRAFT'");
    expect(sql).not.toContain("'PUBLISHED'");
  });

  it('повторный прогон не заводит вторую копию', () => {
    // Идентификатор фиксированный, вставка — с `ON CONFLICT DO NOTHING`.
    expect(sql).toContain('wxp_first_telegram_login');
    expect(sql.match(/ON CONFLICT \("id"\) DO NOTHING/g)).toHaveLength(2);
    expect(sql).not.toContain('cuid()');
  });

  it('русский совет сразу прочитан — иначе его нельзя опубликовать', () => {
    // `canPublish` требует русский текст с `reviewed: true`; без него
    // кнопка «Опубликовать» была бы недоступна, и владелец не понял бы
    // почему.
    expect(sql).toContain("'ADMIN'");
    expect(sql).toMatch(/'ADMIN',\s*\n?\s*true/);
    expect(FIRST_EXPERIENCE.text.locale).toBe('ru');
  });

  it('ключи словаря в записи существуют', () => {
    const keys = uiKeysOf(
      [
        FIRST_EXPERIENCE.text.symptom,
        FIRST_EXPERIENCE.text.cause,
        FIRST_EXPERIENCE.text.advice,
      ].join('\n'),
    );
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(isKnownUiKey(key)).toBe(true);
  });
});
