import { publisherKeys } from '../core/contact-crypto';
import { exportOrder } from '../core/table-registry';
import {
  BACKUP_FORMAT,
  openBackup,
  sealBackup,
  sha256Of,
  tableCountsOf,
  type BackupDocument,
} from './backup-format';
import { exportSql } from './backup.service';
import { csvCell, csvOf, formatOf } from './csv';
import {
  RESTORE_SKIP_TABLES,
  SOFT_REF_COLUMNS,
  orderBySelfRefs,
  restoreOrder,
  selfRefColumns,
} from './restore.service';

const env = {
  ASSIST_SECRETS_KEY: 'unit-test-secret-0123456789abcdef',
} as NodeJS.ProcessEnv;
const env2 = {
  ASSIST_SECRETS_KEY: 'unit-test-secret-v2-0123456789abcdef',
  ASSIST_SECRETS_KEY_VERSION: 'v2',
  ASSIST_SECRETS_KEYS_OLD: 'v1:unit-test-secret-0123456789abcdef',
} as NodeJS.ProcessEnv;

const doc: BackupDocument = {
  format: BACKUP_FORMAT,
  formatVersion: 1,
  exportedAt: '2026-10-13T07:00:00.000Z',
  source: { productId: 'p1', accountId: 'a1', siteId: 's1', kind: 'working' },
  tables: {
    pub_leads: [{ id: 'l1', amountMinor: '9007199254740993' }],
    pub_sources: [],
  },
};

describe('backup-format: gzip → AES-256-GCM, AAD = id копии', () => {
  const keys = publisherKeys('backup', env)!;

  it('круговой путь; bigint строкой без потери точности; счётчики', () => {
    const s = sealBackup(doc, 'bk_1', keys);
    expect(s.keyVersion).toBe('v1');
    expect(s.bytes.subarray(0, 3).toString('ascii')).toBe('v1.');
    expect(s.bytes.includes(Buffer.from('pub_leads'))).toBe(false);
    expect(openBackup(s.bytes, 'bk_1', keys)).toEqual(doc);
    expect(tableCountsOf(doc)).toEqual({ pub_leads: 1, pub_sources: 0 });
    expect(sha256Of(s.bytes)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('чужой id (AAD), порча байта, неизвестная версия ключа — null', () => {
    const s = sealBackup(doc, 'bk_1', keys);
    expect(openBackup(s.bytes, 'bk_2', keys)).toBeNull();
    const bad = Buffer.from(s.bytes);
    bad[bad.length - 1] ^= 1;
    expect(openBackup(bad, 'bk_1', keys)).toBeNull();
    expect(
      openBackup(
        Buffer.from('v9.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'),
        'bk_1',
        keys,
      ),
    ).toBeNull();
    expect(openBackup(Buffer.from('garbage'), 'bk_1', keys)).toBeNull();
  });

  it('ротация ключа: копия v1 открывается связкой v2 с прежним ключом в ASSIST_SECRETS_KEYS_OLD', () => {
    const s = sealBackup(doc, 'bk_1', keys);
    const k2 = publisherKeys('backup', env2)!;
    expect(k2.current).toBe('v2');
    expect(openBackup(s.bytes, 'bk_1', k2)).toEqual(doc);
    const onlyNew = publisherKeys('backup', {
      ASSIST_SECRETS_KEY: env2.ASSIST_SECRETS_KEY,
      ASSIST_SECRETS_KEY_VERSION: 'v2',
    } as NodeJS.ProcessEnv)!;
    expect(openBackup(s.bytes, 'bk_1', onlyNew)).toBeNull();
  });
});

describe('экспорт и порядок восстановления', () => {
  it('SQL экспорта: продукт по id, остальные по productId и кабинету; bigint/Decimal — текстом', () => {
    const t = exportOrder();
    const prod = t.find((x) => x.table === 'pub_products')!;
    expect(exportSql(prod)).toMatch(/t\."id" = \$1 AND t\."accountId" = \$2/);
    const exp = t.find((x) => x.table === 'pub_expenses')!;
    expect(exportSql(exp)).toMatch(
      /'amountTotalMinor', t\."amountTotalMinor"::text/,
    );
    expect(exportSql(exp)).toMatch(/'fxRate', t\."fxRate"::text/);
    expect(exportSql(exp)).toMatch(
      /t\."productId" = \$1 AND t\."accountId" = \$2/,
    );
    expect(t.map((x) => x.table)).not.toEqual(
      expect.arrayContaining(['pub_lead_outbox']),
    );
    expect(t.map((x) => x.table)).not.toContain('pub_notifications');
    expect(t.map((x) => x.table)).not.toContain('pub_idempotency_keys');
    expect(t.map((x) => x.table)).not.toContain('pub_rate_hits');
  });

  it('порядок переноса: родитель раньше ребёнка; решения параметров — раньше голов; служебные таблицы копий не переносятся', () => {
    const order = restoreOrder().map((t) => t.table);
    for (const skip of RESTORE_SKIP_TABLES) expect(order).not.toContain(skip);
    expect(order.indexOf('pub_parameter_decisions')).toBeLessThan(
      order.indexOf('pub_parameters'),
    );
    expect(order.indexOf('pub_parameter_proposals')).toBeLessThan(
      order.indexOf('pub_parameter_decisions'),
    );
    for (const t of restoreOrder()) {
      for (const r of t.refs) {
        if (r.table === 'pub_products') continue;
        expect([
          t.table,
          r.table,
          order.indexOf(r.table) < order.indexOf(t.table),
        ]).toEqual([t.table, r.table, true]);
      }
    }
    expect(Object.keys(SOFT_REF_COLUMNS).every((t) => order.includes(t))).toBe(
      true,
    );
  });

  it('самоссылки: колонки из схемы; строки упорядочены (цель раньше); цикл — ошибка', () => {
    expect(selfRefColumns('PubReport')).toEqual(['supersedesReportId']);
    expect(selfRefColumns('PubContentVersion')).toEqual(['parentVersionId']);
    expect(selfRefColumns('PubExperiment')).toEqual(['supersedesId']);
    const rows = [
      { id: 'c', supersedesId: 'b' },
      { id: 'b', supersedesId: 'a' },
      { id: 'a', supersedesId: null },
      { id: 'x', supersedesId: 'outside' },
    ];
    expect(orderBySelfRefs(rows, ['supersedesId']).map((r) => r.id)).toEqual([
      'a',
      'x',
      'b',
      'c',
    ]);
    expect(() =>
      orderBySelfRefs(
        [
          { id: 'a', s: 'b' },
          { id: 'b', s: 'a' },
        ],
        ['s'],
      ),
    ).toThrow(/цикл/);
  });
});

describe('csv: экранирование формул и кавычек', () => {
  it('значения с = + - @ TAB CR — префикс апострофа; запятые и кавычки — в кавычках', () => {
    expect(['=SUM(A1)', '+1', '-1', '@x', '\tx', '\rx'].map(csvCell)).toEqual([
      "'=SUM(A1)",
      "'+1",
      "'-1",
      "'@x",
      "'\tx",
      `"'\rx"`,
    ]);
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(null)).toBe('');
    expect(csvOf([{ a: 1, b: 'x' }], ['a', 'b'])).toBe('a,b\r\n1,x\r\n');
    expect(formatOf(undefined)).toBe('json');
    expect(formatOf('csv')).toBe('csv');
    expect(() => formatOf('xml')).toThrow();
  });
});
