import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** e2e идёт по СОБРАННЫМ dist/v1/* (тот же код, что уйдёт на CDN). */
export default function globalSetup() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const f of [
    'dist/v1/loader.js',
    'dist/v1/chat.js',
    'dist/v1/chat.css',
  ]) {
    if (!fs.existsSync(path.join(root, f)))
      throw new Error(`e2e: нет ${f} — сначала npm run build`);
  }
}
