// Plain assertions runnable with `npx tsx scripts/voice-commands.test.ts`.
//
// Этап K3 ТЗ Greeting 2.0 §4А.2: реестр голосовых обработчиков экрана —
// «Да» сообщает, что применилось НА САМОМ ДЕЛЕ (аудит волны 1).

import { VoiceCommandRegistry } from '../src/features/voice/voice-commands';

let failed = 0;
let passed = 0;
// `applyCard` асинхронный (K5: «Готово» ждёт сохранений) — проверки
// идут по очереди, итог печатается после последней.
let queue: Promise<void> = Promise.resolve();
function check(name: string, fn: () => void | Promise<void>) {
  queue = queue.then(async () => {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
    }
  });
}
function eq(a: unknown, b: unknown) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${x} !== ${y}`);
}

const f = (target: string, value: string) => ({ target, value, label: target });

check(
  'поля идут владельцу одним вызовом; счёт применённого — без отказов',
  async () => {
    const reg = new VoiceCommandRegistry();
    const calls: string[][] = [];
    reg.addApplier(() => ({
      targets: ['a', 'b'],
      describe: (x) => String(x.value),
      apply: (fields) => {
        calls.push(fields.map((x) => x.target));
        return fields.some((x) => x.target === 'b') ? ['b refused'] : [];
      },
    }));
    eq(
      await reg.applyCard({
        kind: 'fill',
        fields: [f('a', '1'), f('b', '2'), f('zzz', '3')],
      }),
      { kind: 'fill', applied: 1, refusals: ['b refused'] }
    );
    eq(calls, [['a', 'b']]);
  }
);

check('владелец снят — ничего не применено, а не «готово»', async () => {
  const reg = new VoiceCommandRegistry();
  const off = reg.addApplier(() => ({
    targets: ['a'],
    describe: () => '',
    apply: () => [],
  }));
  off();
  eq(reg.canFill('a'), false);
  eq(await reg.applyCard({ kind: 'fill', fields: [f('a', '1')] }), {
    kind: 'fill',
    applied: 0,
    refusals: [],
  });
});

check(
  'действие: запускается обработчик; снятый обработчик — ran: false',
  async () => {
    const reg = new VoiceCommandRegistry();
    let runs = 0;
    const handler = {
      propose: () => ({ kind: 'refuse' as const, text: '' }),
      run: () => {
        runs++;
      },
    };
    const off = reg.addCommand('regenerate-script', () => handler);
    const card = {
      kind: 'action' as const,
      command: 'regenerate-script' as const,
      label: 'L',
    };
    eq(await reg.applyCard(card), { kind: 'action', ran: true, label: 'L' });
    eq(runs, 1);
    off();
    eq(await reg.applyCard(card), { kind: 'action', ran: false, label: 'L' });
    eq(runs, 1);
    // Обработчик на месте, но сейчас «нет» (null) — тоже не запущено.
    reg.addCommand('regenerate-script', () => null);
    eq(await reg.applyCard(card), {
      kind: 'action',
      ran: false,
      label: 'L',
    });
  }
);

check(
  'K5: отчёт владельца — сохранено, ждёт кнопку, не сохранилось; «Готово» после промиса',
  async () => {
    const reg = new VoiceCommandRegistry();
    let resolved = false;
    reg.addApplier(() => ({
      targets: ['s'],
      describe: () => '',
      apply: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            resolved = true;
            resolve({ refusals: [], effects: [{ kind: 'saved' }] });
          }, 5)
        ),
    }));
    reg.addApplier(() => ({
      targets: ['t'],
      describe: () => '',
      apply: () => ({
        refusals: [],
        effects: [
          { kind: 'needs-save', button: 'Сохранить текст' },
          { kind: 'needs-save', button: 'Сохранить текст' },
        ],
      }),
    }));
    reg.addApplier(() => ({
      targets: ['x'],
      describe: () => '',
      apply: () =>
        Promise.resolve({
          refusals: [],
          effects: [{ kind: 'failed' as const, reason: 'Сеть' }],
        }),
    }));
    const out = await reg.applyCard({
      kind: 'fill',
      fields: [f('s', '1'), f('t', '2'), f('x', '3')],
    });
    eq(resolved, true);
    eq(out, {
      kind: 'fill',
      applied: 3,
      refusals: [],
      saved: true,
      needsSave: ['Сохранить текст'],
      failures: ['Сеть'],
    });
  }
);

check('K5: все владельцы зовутся сразу, до первого ожидания', async () => {
  const reg = new VoiceCommandRegistry();
  const order: string[] = [];
  for (const t of ['a', 'b']) {
    reg.addApplier(() => ({
      targets: [t],
      describe: () => '',
      apply: () => {
        order.push(t);
        return new Promise((r) =>
          setTimeout(() => r({ refusals: [], effects: [] }), 5)
        );
      },
    }));
  }
  const p = reg.applyCard({ kind: 'fill', fields: [f('a', '1'), f('b', '2')] });
  eq(order, ['a', 'b']);
  await p;
});

void queue.then(() => {
  console.log(
    failed ? `\n${failed} провалено` : `\n${passed} проверок пройдено`
  );
  if (failed) process.exit(1);
});
