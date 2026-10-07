// Помощники панели темпа. Запуск (из admin/): npm test — или один файл:
// npx tsx src/lib/tutorial-tempo.test.ts
import assert from 'node:assert/strict';
import { hasSourceFile } from './tutorial-tempo';

// Версий не было — ролик и так в исходном файле.
assert.equal(hasSourceFile([]), true);
// Был выбран темп — исходник сохранён версией `source`.
assert.equal(hasSourceFile([{ kind: 'tempo' }, { kind: 'source' }]), true);
// Собран сразу с темпом пары — исходного файла нет, «обычный» — платная сборка.
assert.equal(hasSourceFile([{ kind: 'tempo' }]), false);

console.log('tutorial-tempo.test.ts: ok');
