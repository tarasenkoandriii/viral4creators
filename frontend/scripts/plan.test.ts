// Plain assertions runnable with `npx tsx scripts/plan.test.ts`.
//
// Проверяется главное свойство модуля: интерфейс НЕ знает границ пакетов
// сам, он читает их из ответа сервера. Поэтому фикстура здесь — выдуманная
// матрица, не копия настоящей: если бы helpers где-то подглядывали в свои
// константы, тест бы это поймал.

import {
  allows,
  allowsAspectRatio,
  lockLabel,
  minimalPlanFor,
  planTitle,
  PLAN_ORDER,
} from '../src/lib/plan';
import type {
  PlanDefinition,
  PlanFeature,
  PlanId,
  PlanState,
} from '../src/types';

const NONE: Record<PlanFeature, boolean> = {
  library: false,
  relevance: false,
  audit: false,
  publication: false,
  brandManifest: false,
  referenceAssets: false,
  characterReplacement: false,
  customAspectRatio: false,
};

function def(
  id: PlanId,
  features: Partial<Record<PlanFeature, boolean>>,
  aspectRatios: string[] = []
): PlanDefinition {
  return {
    id,
    title: `Режим ${id}`,
    summary: '',
    features: { ...NONE, ...features },
    aspectRatios,
  };
}

// Этап 56: шаблоны замка приходят от вызывающего (dict.common), а не
// зашиты в lockLabel — те же тексты, что в dictionaries/ru.json.
const t = { availableIn: 'Доступно в {{plan}}', unavailable: 'Недоступно' };

function state(plan: PlanId): PlanState {
  return {
    plan,
    plans: {
      LITE: def('LITE', {}, ['16:9', '9:16']),
      STANDARD: def('STANDARD', { audit: true, relevance: true }),
      PREMIUM: def('PREMIUM', { audit: true, relevance: true, library: true }),
    },
    billingEnabled: false,
  };
}

const checks: Array<[string, boolean]> = [
  [
    'порядок режимов',
    JSON.stringify(PLAN_ORDER) === '["LITE","STANDARD","PREMIUM"]',
  ],

  // allows
  ['Lite не даёт аудит', allows(state('LITE'), 'audit') === false],
  ['Standard даёт аудит', allows(state('STANDARD'), 'audit') === true],
  [
    'Standard не даёт библиотеку',
    allows(state('STANDARD'), 'library') === false,
  ],
  ['Premium даёт библиотеку', allows(state('PREMIUM'), 'library') === true],
  // Пока матрица не пришла — ничего не разрешено: лучше не нарисовать
  // кнопку, чем нарисовать ту, которую сервер запретит.
  ['без состояния всё закрыто', allows(null, 'audit') === false],

  // minimalPlanFor / lockLabel — подпись замка берётся из матрицы, а не
  // из зашитого «Premium».
  [
    'минимальный для аудита — Standard',
    minimalPlanFor(state('LITE'), 'audit') === 'STANDARD',
  ],
  [
    'минимальный для библиотеки — Premium',
    minimalPlanFor(state('LITE'), 'library') === 'PREMIUM',
  ],
  [
    'нигде не включённая возможность — null',
    minimalPlanFor(state('LITE'), 'publication') === null,
  ],
  [
    'подпись замка из названия режима',
    lockLabel(state('LITE'), 'audit', t) === 'Доступно в Режим STANDARD',
  ],
  [
    'подпись при недоступности везде',
    lockLabel(state('LITE'), 'publication', t) === 'Недоступно',
  ],
  ['название режима', planTitle(state('LITE'), 'PREMIUM') === 'Режим PREMIUM'],

  // aspectRatios: пустой список = любые
  ['Lite разрешает 9:16', allowsAspectRatio(state('LITE'), '9:16') === true],
  ['Lite запрещает 4:5', allowsAspectRatio(state('LITE'), '4:5') === false],
  [
    'Standard разрешает 4:5',
    allowsAspectRatio(state('STANDARD'), '4:5') === true,
  ],
];

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed++;
  console.log(ok ? 'ok  ' : 'FAIL', name);
}
if (failed) process.exit(1);
console.log('plan: all cases pass');
