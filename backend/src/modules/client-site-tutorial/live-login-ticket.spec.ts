/**
 * Квитанция живого входа (§7.4.4/§7.4.5 ТЗ, этап 114).
 *
 * Главный тест здесь — предпоследний: квитанция ДРУГОГО черновика не
 * принимается. Без этой проверки `complete` брал бы `sessionId` из тела
 * запроса, и сосед, подставив чужой идентификатор, записал бы чужую
 * живую сессию к чужому кабинету в свой черновик.
 */

import { encryptToken } from '../../common/token-crypto';
import {
  LIVE_TICKET_TTL_MS,
  LiveTicketError,
  issueLiveTicket,
  readLiveTicket,
} from './live-login-ticket';

const KEY = Buffer.alloc(32, 5).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 6).toString('base64');
const NOW = new Date('2026-09-16T12:00:00Z');

function issue(over: { sessionId?: string; draftId?: string } = {}) {
  return issueLiveTicket(
    { sessionId: over.sessionId ?? 'relay-1', draftId: over.draftId ?? 'd1' },
    KEY,
    NOW,
  );
}

describe('обычный круг', () => {
  it('выданная квитанция читается и отдаёт свой sessionId', () => {
    expect(readLiveTicket(issue(), { draftId: 'd1' }, KEY, NOW)).toBe(
      'relay-1',
    );
  });

  it('sessionId не виден в самой квитанции', () => {
    // Она уезжает клиенту; читать из неё что-либо он не должен.
    expect(issue()).not.toContain('relay-1');
    expect(issue()).not.toContain('d1');
  });

  it('живёт дольше самой сессии реле, но не бесконечно', () => {
    const ticket = issue();
    const almost = new Date(NOW.getTime() + LIVE_TICKET_TTL_MS - 1000);
    expect(readLiveTicket(ticket, { draftId: 'd1' }, KEY, almost)).toBe(
      'relay-1',
    );
    // Потолок сессии на реле — 3 минуты стены; квитанция обязана его
    // пережить, иначе человек, нажавший «Готово» вовремя, получал бы
    // отказ на ровном месте.
    expect(LIVE_TICKET_TTL_MS).toBeGreaterThan(3 * 60 * 1000);
  });
});

describe('квитанцию нельзя подменить', () => {
  it('квитанция ЧУЖОГО черновика — отказ', () => {
    // Ровно та дыра, ради которой заведена квитанция.
    const foreign = issue({ draftId: 'd2', sessionId: 'чужая-сессия' });
    expect(() => readLiveTicket(foreign, { draftId: 'd1' }, KEY, NOW)).toThrow(
      LiveTicketError,
    );
  });

  it('истёкшая — отказ с внятной причиной', () => {
    const ticket = issue();
    const late = new Date(NOW.getTime() + LIVE_TICKET_TTL_MS + 1);
    expect(() => readLiveTicket(ticket, { draftId: 'd1' }, KEY, late)).toThrow(
      /истекла/,
    );
  });

  it('подписанная другим ключом — отказ', () => {
    const ticket = issueLiveTicket(
      { sessionId: 'relay-1', draftId: 'd1' },
      OTHER_KEY,
      NOW,
    );
    expect(() => readLiveTicket(ticket, { draftId: 'd1' }, KEY, NOW)).toThrow(
      LiveTicketError,
    );
  });

  it('мусор вместо квитанции — отказ, а не падение', () => {
    expect(() =>
      readLiveTicket('не-квитанция', { draftId: 'd1' }, KEY, NOW),
    ).toThrow(LiveTicketError);
  });

  it('валидно зашифрованная, но неправильная по форме — отказ', () => {
    // Такую мог оставить более старый код: шифр наш, содержимое чужое.
    const ticket = encryptToken(JSON.stringify({ nope: true }), KEY);
    expect(() => readLiveTicket(ticket, { draftId: 'd1' }, KEY, NOW)).toThrow(
      LiveTicketError,
    );
  });

  it('три причины отказа различимы по тексту', () => {
    // Для стенда это разные диагнозы: смена ключа, обычная жизнь и то,
    // чего у честного клиента быть не может.
    const texts: string[] = [];
    for (const run of [
      () => readLiveTicket('мусор', { draftId: 'd1' }, KEY, NOW),
      () =>
        readLiveTicket(issue({ draftId: 'd2' }), { draftId: 'd1' }, KEY, NOW),
      () =>
        readLiveTicket(
          issue(),
          { draftId: 'd1' },
          KEY,
          new Date(NOW.getTime() + LIVE_TICKET_TTL_MS + 1),
        ),
    ]) {
      try {
        run();
      } catch (e) {
        texts.push((e as Error).message);
      }
    }
    expect(new Set(texts).size).toBe(3);
  });
});
