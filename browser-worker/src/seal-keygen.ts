/**
 * Пара ключей конверта учёток (Э-С Ш3, doc/DEPLOYMENT.md §6.25):
 * открытый — в env sites-backend (`SITES_WORKER_SEAL_PUBLIC_KEY`), закрытый —
 * ТОЛЬКО в env воркера (`BROWSER_WORKER_SEAL_PRIVATE_KEY`).
 *   docker compose run --rm browser-worker node dist/seal-keygen.js
 */
import { generateWorkerSealKeys } from './shared/worker-seal';

const k = generateWorkerSealKeys();
process.stdout.write(
  [
    '# sites-backend (Vercel → Environment Variables):',
    `SITES_WORKER_SEAL_PUBLIC_KEY=${k.publicKey}`,
    '# browser-worker (.env на VPS, больше нигде):',
    `BROWSER_WORKER_SEAL_PRIVATE_KEY=${k.privateKey}`,
    '',
  ].join('\n'),
);
