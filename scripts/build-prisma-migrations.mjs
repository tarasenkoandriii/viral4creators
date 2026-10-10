import { spawnSync } from 'node:child_process';

// Preview никогда не меняет общую production-базу. Остальные сборки
// сохраняют прежнюю обязательную миграцию и отказ при её ошибке.
if (process.env.VERCEL_ENV === 'preview') {
  console.log('Preview: database migrations skipped; compilation continues');
} else {
  const result = spawnSync('prisma', ['migrate', 'deploy'], { stdio: 'inherit', shell: false });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
