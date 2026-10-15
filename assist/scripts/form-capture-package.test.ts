import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
execFileSync('python3', ['scripts/package-form-capture.py', '--check'], {
  cwd: root,
  stdio: 'inherit',
});
execFileSync(
  process.execPath,
  ['--test', 'tools/form-capture/capture.test.js'],
  { cwd: root, stdio: 'inherit' }
);
console.log('Form capture archive and no-value collector checks passed');
