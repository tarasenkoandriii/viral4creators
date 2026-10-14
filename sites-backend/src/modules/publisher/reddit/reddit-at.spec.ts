/**
 * P-R — каталог AT-RD (reddit-manual-mvp-adapted.md §9) ↔ тесты с метками:
 * у каждого сценария M1 и M2 есть `describe`/`it` с меткой `[AT-RD-NN]` в
 * файле из каталога (P-R M2: AT-RD-07…14 реализованы); отчёт P0 (44
 * сценария) каталог P-R не затрагивает.
 */
import * as fs from 'fs';
import * as path from 'path';
import { AT_CATALOG, AT_RD_CATALOG, isAtRdId } from '../reports/qa/at-catalog';
import { buildAtReport } from '../reports/qa/at-report';

const SRC = path.join(__dirname, '../../..');

function specFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...specFiles(f));
    else if (/\.spec\.ts$/.test(e.name)) out.push(f);
  }
  return out;
}

describe('qa/at-catalog: AT-RD (P-R) ↔ метки тестов', () => {
  const files = specFiles(SRC);
  const labelled = (id: string) =>
    files.filter((f) => fs.readFileSync(f, 'utf8').includes(`[${id}]`));

  it('18 сценариев AT-RD-01…18, вне шлюзов P0; P0-каталог — по-прежнему 44', () => {
    expect(AT_RD_CATALOG.map((c) => c.id)).toEqual(
      Array.from(
        { length: 18 },
        (_, i) => `AT-RD-${String(i + 1).padStart(2, '0')}`,
      ),
    );
    expect(
      AT_RD_CATALOG.every((c) => isAtRdId(c.id) && c.gates.length === 0),
    ).toBe(true);
    expect(AT_CATALOG).toHaveLength(44);
    expect(
      AT_RD_CATALOG.filter((c) => c.stage === 'M1').map((c) => c.id),
    ).toEqual([
      'AT-RD-01',
      'AT-RD-02',
      'AT-RD-03',
      'AT-RD-04',
      'AT-RD-05',
      'AT-RD-06',
      'AT-RD-15',
      'AT-RD-16',
      'AT-RD-17',
      'AT-RD-18',
    ]);
  });

  it('M1 и M2: у каждого сценария есть тест с меткой в файле каталога', () => {
    const verdict = AT_RD_CATALOG.map((c) => {
      const hits = labelled(c.id).map((f) => path.basename(f, '.ts'));
      return { id: c.id, ok: hits.some((h) => c.files.includes(h)) };
    });
    expect(verdict.filter((v) => !v.ok)).toEqual([]);
    expect(
      AT_RD_CATALOG.filter((c) => c.stage === 'M2').map((c) => c.id),
    ).toEqual([
      'AT-RD-07',
      'AT-RD-08',
      'AT-RD-09',
      'AT-RD-10',
      'AT-RD-11',
      'AT-RD-12',
      'AT-RD-13',
      'AT-RD-14',
    ]);
    expect(
      AT_RD_CATALOG.filter((c) => /не реализован/.test(c.automated)),
    ).toEqual([]);
  });

  it('отчёт по каталогу P-R без результатов jest → blocked (не passed)', () => {
    const r = buildAtReport(
      { success: true, startTime: 0, testResults: [] } as never,
      { catalog: AT_RD_CATALOG },
    );
    expect(r.cases).toHaveLength(18);
    expect(r.summary.blocked).toHaveLength(18);
  });
});
