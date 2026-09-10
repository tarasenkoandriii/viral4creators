import { describeDbFailure, describeTarget } from './db-error';

const URL_WITH_SECRET =
  'postgresql://postgres:sup3r-s3cret@db.abcdef.supabase.co:6543/postgres?sslmode=require';

describe('диагностика сбоя связи с БД (этап 29)', () => {
  it('в цель попадают хост, порт и имя базы — но не логин и пароль', () => {
    expect(describeTarget(URL_WITH_SECRET)).toBe(
      'db.abcdef.supabase.co:6543/postgres',
    );
    expect(describeTarget(URL_WITH_SECRET)).not.toContain('sup3r-s3cret');
    expect(describeTarget('не url')).toBeNull();
    expect(describeTarget(undefined)).toBeNull();
  });

  it('различает виды сбоя и на каждый даёт подсказку', () => {
    const cases: Array<[string, string]> = [
      ['connect ECONNREFUSED 127.0.0.1:5432', 'unreachable'],
      ["Can't reach database server at `db:5432`", 'unreachable'],
      ['password authentication failed for user "postgres"', 'auth'],
      ['connect ETIMEDOUT', 'timeout'],
      ['self signed certificate in certificate chain', 'tls'],
      ['что-то совсем иное', 'unknown'],
    ];
    for (const [raw, kind] of cases) {
      const info = describeDbFailure(new Error(raw), URL_WITH_SECRET);
      expect(info.kind).toBe(kind);
      expect(info.hint.length).toBeGreaterThan(20);
      expect(info.message).toContain('db.abcdef.supabase.co:6543/postgres');
    }
  });

  it('пароль не протекает даже если он был внутри сообщения драйвера', () => {
    const info = describeDbFailure(
      new Error(`failed to connect to ${URL_WITH_SECRET}`),
      URL_WITH_SECRET,
    );
    expect(info.message).not.toContain('sup3r-s3cret');
    expect(info.message).toContain('***@');
  });

  it('переживает не-Error и отсутствующий DATABASE_URL', () => {
    const info = describeDbFailure('строка вместо ошибки', undefined);
    expect(info.target).toBeNull();
    expect(info.message).toContain('строка вместо ошибки');
  });
});
