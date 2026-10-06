import { createLogger, redact } from '../../src/logger';
import { SecretBox } from '../../src/secret-box';

describe('журнал без ПД и затирание секрета', () => {
  it('в журнал идут только поля белого списка (адресов страниц нет)', () => {
    const lines: string[] = [];
    const log = createLogger('debug', (l) => lines.push(l));
    log.info('задание', {
      jobId: 'j1',
      ...({ url: 'https://shop.test/u/ivan@example.com?token=1' } as object),
    });
    expect(lines[0]).toContain('"jobId":"j1"');
    expect(lines[0]).not.toContain('ivan@example.com');
    expect(lines[0]).not.toContain('url');
  });

  it('секрет, пока жив, вырезается из любой строки журнала; после wipe — затёрт', async () => {
    const pw = ['Secret', 'Pw', '42xyz'].join('-');
    const lines: string[] = [];
    const log = createLogger('debug', (l) => lines.push(l));
    const box = new SecretBox(pw);
    log.warn(`ошибка входа с паролем ${pw}`, { reason: `pw=${pw}` });
    expect(lines.join('\n')).not.toContain(pw);
    expect(lines.join('\n')).toContain('[secret]');
    await expect(box.reveal(async (p) => p.length)).resolves.toBe(pw.length);
    const bytes = box.bytesForTest()!;
    box.wipe();
    expect(bytes.every((b) => b === 0)).toBe(true);
    expect(box.wiped).toBe(true);
    await expect(box.reveal(async () => 1)).rejects.toThrow(/затёрт/);
    // После затирания значение больше не держится в редакторе.
    expect(redact(pw)).toBe(pw);
  });

  it('Buffer на входе затирается сразу (копия — внутри коробки)', () => {
    const src = Buffer.from('top-secret-value');
    const box = new SecretBox(src);
    expect(src.every((b) => b === 0)).toBe(true);
    box.wipe();
  });
});
