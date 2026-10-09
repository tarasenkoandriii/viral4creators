/**
 * `backend/server.js` — вход Vercel (zero-config «Deploy a Node.js server»)
 * и `npm run start:prod`. Заход 12, аудит P2-2: `nest build` кладёт вход в
 * `dist/src/main.js` (rootDir = backend/ из-за импорта `vercel.json` в
 * `cron-schedule.ts`), а `server.js` требовал только `./dist/main.js` —
 * `Cannot find module`. Теперь берётся существующий из двух, при обоих —
 * более свежий. Проверка — копией `server.js` во временной папке с
 * поддельными входами (настоящий вход поднял бы приложение).
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SERVER_JS = path.join(__dirname, '..', 'server.js');

function run(layout: { flat?: number; nested?: number }): {
  status: number | null;
  out: string;
  err: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-entry-'));
  try {
    fs.copyFileSync(SERVER_JS, path.join(dir, 'server.js'));
    const put = (rel: string, label: string, ageSec: number) => {
      const f = path.join(dir, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, `process.stdout.write(${JSON.stringify(label)});\n`);
      const t = new Date(Date.now() - ageSec * 1000);
      fs.utimesSync(f, t, t);
    };
    if (layout.flat !== undefined) put('dist/main.js', 'flat', layout.flat);
    if (layout.nested !== undefined) {
      put('dist/src/main.js', 'nested', layout.nested);
    }
    const r = spawnSync(process.execPath, [path.join(dir, 'server.js')], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    return { status: r.status, out: r.stdout, err: r.stderr };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('backend/server.js: вход dist/main.js | dist/src/main.js', () => {
  it('только dist/src/main.js (текущая раскладка nest build) — его', () => {
    expect(run({ nested: 0 })).toMatchObject({ status: 0, out: 'nested' });
  });

  it('только dist/main.js (прежняя раскладка) — его', () => {
    expect(run({ flat: 0 })).toMatchObject({ status: 0, out: 'flat' });
  });

  it('оба: старый dist/main.js от прошлой сборки не выигрывает у свежего', () => {
    expect(run({ flat: 3600, nested: 0 })).toMatchObject({ out: 'nested' });
    expect(run({ flat: 0, nested: 3600 })).toMatchObject({ out: 'flat' });
  });

  it('ни одного — понятная ошибка, а не молчание', () => {
    const r = run({});
    expect(r.status).not.toBe(0);
    expect(r.err).toMatch(/npm run build/);
  });

  it('оба require — литералы: трассировщик файлов Vercel (@vercel/nft) их видит', () => {
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    expect(src).toContain("require('./dist/main.js')");
    expect(src).toContain("require('./dist/src/main.js')");
  });

  it('start:prod идёт через server.js', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts['start:prod']).toBe('node server.js');
  });
});
