/**
 * Аудит Э8 (6), заход 9: компонентный тест карточки подтверждения TMA
 * (`ProposalCard.tsx`) без новых зависимостей — `react-dom/server`
 * (`renderToStaticMarkup`) с настоящими провайдерами контекста:
 *  - pending: «было → станет», «Так»/«Ні», пометка «без вашого прохання»;
 *  - danger: слово подтверждения и «скасувати не можна»;
 *  - unknown: «Перевірити», повтор с отметкой «я перевірив» (не идемпотентно);
 *  - expired после «Так» (Р-З9-21): «повтор більше не приймається»;
 *  - значения — только текстом (HTML из API не исполняется);
 *  - язык — из локали кабинета.
 */
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KitContext, type KitValue } from '../src/kit/kit-context';
import { AssistContext, type AssistValue } from '../src/lib/assist-context';
import { type Proposal, parseProposal } from '../src/lib/admin-actions-api';
import { ADMIN_ACTIONS_TEXTS } from '../src/i18n/admin-actions';
import { ProposalCard } from '../src/screens/admin/ProposalCard';

function card(p: Partial<Proposal> & Record<string, unknown>, locale = 'uk') {
  const kit = {
    locale,
    dict: {},
    account: { me: { role: 'owner', productRoles: {} } },
  } as unknown as KitValue;
  const assist = {
    adminActions: {},
    appDict: {},
  } as unknown as AssistValue;
  const proposal = parseProposal({
    id: 'p1',
    status: 'pending',
    kind: 'write',
    title: 'Змінити статус',
    operation: 'shop.updateOrderStatus',
    fields: [{ name: 'status', before: 'paid', after: 'shipped' }],
    paramsHash: 'a'.repeat(64),
    dryRun: 'preview',
    ...p,
  });
  return renderToStaticMarkup(
    createElement(
      KitContext.Provider,
      { value: kit },
      createElement(
        AssistContext.Provider,
        { value: assist },
        createElement(ProposalCard, {
          siteId: 's1',
          p: proposal,
          onChange: () => undefined,
        })
      )
    )
  );
}

const uk = ADMIN_ACTIONS_TEXTS.uk.card;
const ru = ADMIN_ACTIONS_TEXTS.ru.card;

// pending write: «было → станет», кнопки «Так»/«Ні», пометка «без прохання».
const pending = card({ unrequested: true });
assert.ok(pending.includes(uk.title), 'заголовок');
assert.ok(/<s[^>]*>paid<\/s> → shipped/.test(pending), 'было → станет');
assert.ok(pending.includes(`>${uk.yes}<`), 'кнопка «Так»');
assert.ok(pending.includes(`>${uk.no}<`), 'кнопка «Ні»');
assert.ok(pending.includes(uk.unrequested), 'без вашого прохання');
assert.ok(pending.includes(uk.status.pending));
assert.equal(pending.includes(uk.retry), false, 'повтора у pending нет');
assert.equal(pending.includes(uk.retryExpired), false);

// danger без компенсации: слово подтверждения и «скасувати не можна».
const danger = card({
  kind: 'danger',
  confirmPhrase: 'ПІДТВЕРДЖУЮ 3',
  undoDeclared: false,
});
assert.ok(danger.includes(uk.phraseHint));
assert.ok(danger.includes('<b>ПІДТВЕРДЖУЮ 3</b>'));
assert.ok(danger.includes('<input'), 'поле для слова');
assert.ok(danger.includes(uk.noUndo));
assert.ok(danger.includes('border-l-rose-500'));

// unknown, не идемпотентно: «Перевірити», повтор и «я перевірив»; без «Так».
const unknown = card({
  status: 'unknown',
  idempotent: false,
  checkAvailable: true,
  attempts: 1,
});
assert.ok(unknown.includes(uk.status.unknown));
assert.ok(unknown.includes(`>${uk.check}<`));
assert.ok(unknown.includes(`>${uk.retry}<`));
assert.ok(unknown.includes(uk.retryAck));
assert.ok(unknown.includes('type="checkbox"'));
assert.equal(unknown.includes(`>${uk.yes}<`), false);
// Идемпотентная — отметка «я перевірив» не нужна.
const idem = card({ status: 'unknown', idempotent: true, attempts: 1 });
assert.equal(idem.includes(uk.retryAck), false);

// Р-З9-21: «Так» было, карточка истекла — повтор закрыт, кнопок нет.
const closed = card({ status: 'expired', attempts: 1, outcome: 'timeout' });
assert.ok(closed.includes(uk.retryExpired));
assert.equal(closed.includes(`>${uk.retry}<`), false);
assert.equal(closed.includes(`>${uk.yes}<`), false);
// Истекла без «Так» (10 минут) — обычное «застаріла», без подсказки повтора.
const stale = card({ status: 'expired', attempts: 0 });
assert.ok(stale.includes(uk.status.expired));
assert.equal(stale.includes(uk.retryExpired), false);

// Значения из API — только текстом.
const xss = card({
  fields: [{ name: 'note', after: '<img src=x onerror=alert(1)>' }],
  errorText: '<script>alert(2)</script>',
  status: 'failed',
});
assert.equal(xss.includes('<img'), false);
assert.equal(xss.includes('<script'), false);
assert.ok(xss.includes('&lt;img src=x onerror=alert(1)&gt;'));

// Язык — из локали кабинета.
const inRu = card({ unrequested: true }, 'ru');
assert.ok(inRu.includes(ru.unrequested));
assert.ok(inRu.includes(`>${ru.yes}<`));
assert.equal(inRu.includes(uk.unrequested), false);

console.log('ok proposal-card');
