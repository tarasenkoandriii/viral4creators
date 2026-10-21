/**
 * Точка входа контейнера executor (`node dist/executor/main.js`).
 *
 * Контейнер: network_mode none, read_only, cap_drop ALL, no-new-privileges,
 * non-root, лимиты CPU/RAM/PIDs, tmpfs /tmp, общий volume workspace и
 * read-only volume шрифтов; init (tini) — чтобы осиротевшие процессы
 * reap-ились. Секретов и сети нет.
 *
 * env:
 *   WORKSPACE_ROOT          — обязателен (общий volume с API);
 *   FFMPEG_BIN              — /usr/bin/ffmpeg;
 *   FFPROBE_BIN             — /usr/bin/ffprobe;
 *   EXECUTOR_POLL_MS        — 500;
 *   EXECUTOR_HEARTBEAT_MS   — 1000;
 *   EXECUTOR_TMP_DIR        — /tmp (HOME и кеш fontconfig ffmpeg);
 *   FONTCONFIG_FILE / FONTCONFIG_PATH — передаются ffmpeg как есть.
 *
 * umask 007: файлы попыток group-rw для API (другой uid, общая группа).
 */
import { Executor } from './executor';

function intEnv(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : def;
}

export async function main(): Promise<void> {
  // API и executor — разные uid в общей группе workspace (setgid-корень):
  // файлы и каталоги попыток должны быть group-rw, иначе API не удалит
  // созданное executor. umask наследуют и процессы ffmpeg.
  process.umask(0o007);
  const root = process.env.WORKSPACE_ROOT;
  if (!root) {
    process.stderr.write('WORKSPACE_ROOT is required\n');
    process.exit(2);
  }
  const executor = new Executor({
    workspaceRoot: root,
    ffmpegBin: process.env.FFMPEG_BIN || '/usr/bin/ffmpeg',
    ffprobeBin: process.env.FFPROBE_BIN || '/usr/bin/ffprobe',
    pollMs: intEnv('EXECUTOR_POLL_MS', 500),
    heartbeatMs: intEnv('EXECUTOR_HEARTBEAT_MS', 1000),
    tmpDir: process.env.EXECUTOR_TMP_DIR || '/tmp',
    passEnv: {
      FONTCONFIG_FILE: process.env.FONTCONFIG_FILE,
      FONTCONFIG_PATH: process.env.FONTCONFIG_PATH,
    },
    log: (m) => process.stderr.write(`${new Date().toISOString()} ${m}\n`),
  });
  const ac = new AbortController();
  const stop = (sig: string) => {
    process.stderr.write(`executor: ${sig}, stopping\n`);
    ac.abort();
    void executor.shutdown().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  await executor.init();
  process.stderr.write(
    `executor started, ffmpeg ${executor.version ?? 'unknown'}\n`,
  );
  await executor.loop(ac.signal);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`executor crashed: ${String(e)}\n`);
    process.exit(1);
  });
}
