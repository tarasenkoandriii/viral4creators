/** CSV экспорта (A, §5-тер.7, приёмка §5-тер.16 п.8): инъекция формул, BOM, кириллица, кавычки. */
import { CSV_BOM, csvCell, csvRows } from './csv';

describe('csv (A)', () => {
  it('ячейка, начинающаяся с = + - @ таб или перевода строки, — с ведущим апострофом', () => {
    expect(csvCell('=HYPERLINK("https://evil.com","жми")')).toBe(
      `"'=HYPERLINK(""https://evil.com"",""жми"")"`,
    );
    expect(csvCell('+380')).toBe("'+380");
    expect(csvCell('-1+2')).toBe("'-1+2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('\nx')).toBe(`"'\nx"`);
    expect(csvCell('обычный текст')).toBe('обычный текст');
    // Excel uk/ru делит CSV по `;`: формула после `;` — внутри кавычек.
    expect(csvCell('ок;=SUM(A1:A9)')).toBe('"ок;=SUM(A1:A9)"');
    // Числа кода — не формулы.
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
    expect(csvCell(true)).toBe('true');
  });

  it('файл: BOM, CRLF, кириллица байтами UTF-8, кавычки и запятые', () => {
    const out = csvRows(['дата', 'текст'], [['2026-10-02', 'привіт, "світ"']]);
    expect(out.startsWith(CSV_BOM)).toBe(true);
    expect(Buffer.from(out, 'utf8').subarray(0, 3)).toEqual(
      Buffer.from([0xef, 0xbb, 0xbf]),
    );
    expect(out).toBe(
      `${CSV_BOM}дата,текст\r\n2026-10-02,"привіт, ""світ"""\r\n`,
    );
  });
});
