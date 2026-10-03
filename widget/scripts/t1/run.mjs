#!/usr/bin/env node
/**
 * Т-1 (ТЗ §5-бис.12) — прогон по уровням с отчётом-ссылками:
 *
 *   node scripts/t1/run.mjs unit          # конвейер фикстур, детектор речи, сверка портов (секунды)
 *   node scripts/t1/run.mjs transcript    # 30 команд PR-набора на стендах (T1_FULL=1 — все 480)
 *   node scripts/t1/run.mjs audio-small   # мок-фикстуры + звук в Chromium двумя способами
 *   node scripts/t1/run.mjs audio-full    # ВЛАДЕЛЕЦ: SONIOX_API_KEY, синтез full + распознавание
 *                                         #   + весь набор стендов распознанными текстами
 *   node scripts/t1/run.mjs pr            # unit + transcript + audio-small (каждый PR)
 *
 * Перед e2e — `npm run build` (globalSetup проверяет dist). Итог —
 * test-results/t1-summary.md со ссылками на отчёты уровней. Живые
 * WebKit/iOS — ручной чек-лист (doc/DEPLOYMENT.md, «Т-1 вручную»).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const level = process.argv[2] || 'pr';
const LEVELS = ['unit', 'transcript', 'audio-small', 'audio-full', 'pr'];
if (!LEVELS.includes(level)) {
  console.error(`уровень: ${LEVELS.join(' | ')}`);
  process.exit(2);
}
const out = path.resolve('test-results');
fs.mkdirSync(out, { recursive: true });
const done = [];

function sh(title, cmd, args, env = {}) {
  console.log(`\n── Т-1: ${title}`);
  const t0 = Date.now();
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  const ok = r.status === 0;
  done.push({ title, ok, s: Math.round((Date.now() - t0) / 1000) });
  if (!ok) finish(1);
}

function finish(code) {
  const links = [
    ['transcript', 't1-report.md'],
    ['фикстуры', 't1-fixtures/manifest.json'],
    ['распознавание', 't1-fixtures/wer.md'],
  ].filter(([, f]) => fs.existsSync(path.join(out, f)));
  const md = [
    `# Т-1: ${level}`,
    '',
    ...done.map((d) => `- ${d.ok ? '✓' : '✗'} ${d.title} (${d.s} с)`),
    '',
    ...links.map(([t, f]) => `- ${t}: [${f}](./${f})`),
    '',
    'WebKit/Safari и живые телефоны — ручной чек-лист doc/DEPLOYMENT.md («Т-1 вручную»).',
  ].join('\n');
  fs.writeFileSync(path.join(out, 't1-summary.md'), md);
  console.log(`\n${md}`);
  process.exit(code);
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const pw = (spec, env) =>
  sh(`e2e ${spec}`, npx, ['playwright', 'test', spec, '--workers=1'], env);

if (level === 'unit' || level === 'pr') {
  sh('юнит: конвейер фикстур', npx, ['tsx', 'scripts/t1.test.ts']);
  sh('юнит: сверка с сервером', npx, ['tsx', 'scripts/ui-plan.test.ts']);
}
if (level === 'transcript' || level === 'pr')
  pw('e2e/voice-control-stands.spec.ts');
if (level === 'audio-small' || level === 'pr') {
  sh('сборка тестового голосового чанка', 'npm', ['run', 'build:test-audio']);
  sh('фикстуры (мок-синтез, small)', npx, [
    'tsx',
    'scripts/t1/synth.ts',
    '--set=small',
  ]);
  sh('распознавание (мок)', npx, [
    'tsx',
    'scripts/t1/recognize.ts',
    '--stt=mock',
  ]);
  pw('e2e/voice-control-audio.spec.ts');
}
if (level === 'audio-full') {
  if (!process.env.SONIOX_API_KEY) {
    console.error('audio-full — у владельца: нужен SONIOX_API_KEY (и ffmpeg).');
    process.exit(2);
  }
  const dir = path.join(out, 't1-fixtures');
  sh('фикстуры (Soniox, full)', npx, [
    'tsx',
    'scripts/t1/synth.ts',
    '--provider=soniox',
    '--set=full',
    `--out=${dir}`,
  ]);
  sh('распознавание (Soniox)', npx, [
    'tsx',
    'scripts/t1/recognize.ts',
    `--dir=${dir}`,
  ]);
  pw('e2e/voice-control-stands.spec.ts', {
    T1_FULL: '1',
    T1_RECOGNIZED: path.join(dir, 'recognized.json'),
  });
  sh('сборка тестового голосового чанка', 'npm', ['run', 'build:test-audio']);
  pw('e2e/voice-control-audio.spec.ts');
}
finish(0);
