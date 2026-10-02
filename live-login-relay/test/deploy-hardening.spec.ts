/**
 * Шов «образ и compose держат изоляцию» (Ш0.2 аудита 02.10.2026, К-1).
 *
 * Настоящий Docker в CI реле не поднимается, а эти строки — ровно те,
 * которые легко «временно» убрать при отладке и забыть: USER, отказ от
 * capabilities, неопубликованный 8088, фильтр по умолчанию. Поэтому они
 * сверяются с файлами как текст.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');

/** Строки без комментариев — закомментированный `ports:` не публикация. */
const code = (text: string) =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

describe('Dockerfile', () => {
  it('процесс работает НЕ от root: USER node после установки пакетов и до CMD', () => {
    const lines = code(dockerfile).split('\n');
    const user = lines.findIndex((l) => /^USER\s+node\s*$/.test(l));
    const lastRun = lines.map((l) => /^RUN\s/.test(l)).lastIndexOf(true);
    const cmd = lines.findIndex((l) => /^CMD\s/.test(l));
    expect(user).toBeGreaterThan(lastRun);
    expect(user).toBeLessThan(cmd);
    expect(code(dockerfile)).not.toMatch(/^USER\s+root/m);
  });
});

describe('docker-compose.yml', () => {
  const body = code(compose);

  it('порт 8088 наружу не публикуется (только expose)', () => {
    expect(body).not.toMatch(/^\s*ports:/m);
    expect(body).toMatch(/expose:\s*\n\s*-\s*'8088'/);
  });

  it('без capabilities и без повышения привилегий', () => {
    expect(body).toMatch(/cap_drop:\s*\n\s*-\s*ALL/);
    expect(body).toMatch(/no-new-privileges:true/);
  });

  it('фильтр исходящего трафика по умолчанию включён', () => {
    expect(body).toContain(
      'LIVE_LOGIN_EGRESS_FILTER=${LIVE_LOGIN_EGRESS_FILTER:-on}',
    );
    expect(body).toContain('LIVE_LOGIN_EGRESS_DENY=');
  });
});
