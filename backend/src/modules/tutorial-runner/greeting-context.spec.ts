/**
 * Три состояния мастера поздравления — какой проект какому экрану
 * (29.09.2026).
 *
 * Проверяется чистая функция без базы, потому что ошибка здесь молчит:
 * маршрут откроется, кадр снимется, ролик соберётся — и покажет не тот
 * экран. Падения не будет ни на одном шаге.
 */

import { SessionStatus } from '../../common/types/session.types';
import { greetingContext } from './tutorial-scenario-runner.service';

const p = (id: string, ...statuses: SessionStatus[]) => ({
  id,
  sessions: statuses.map((status) => ({ status })),
});

describe('greetingContext', () => {
  it('проект без сессий — экран брифа', () => {
    expect(greetingContext([p('a')])).toEqual({ greetingProjectId: 'a' });
  });

  it('последняя сессия без сценария — экран «собрать сценарий»', () => {
    expect(greetingContext([p('a', SessionStatus.CREATED)])).toEqual({
      greetingDraftingProjectId: 'a',
    });
  });

  it('последняя сессия со сценарием — экран всех девяти карточек', () => {
    expect(greetingContext([p('a', SessionStatus.PROMPT_GENERATED)])).toEqual({
      greetingReadyProjectId: 'a',
    });
  });

  /**
   * Статус сессии только растёт: готовый ролик — это тоже «сценарий
   * собран», и карточки на экране те же. Отнести его к «сценария нет»
   * значило бы открыть сценарию экран, где кнопки «собрать сценарий»
   * давно нет.
   */
  it('ролик готов или рендерится — всё ещё экран со сценарием', () => {
    expect(greetingContext([p('a', SessionStatus.VIDEO_COMPLETE)])).toEqual({
      greetingReadyProjectId: 'a',
    });
    expect(greetingContext([p('b', SessionStatus.GENERATING_VIDEO)])).toEqual({
      greetingReadyProjectId: 'b',
    });
  });

  it('три проекта дают три разных поля — это и есть три экрана', () => {
    expect(
      greetingContext([
        p('fresh'),
        p('draft', SessionStatus.CREATED),
        p('ready', SessionStatus.PROMPT_GENERATED),
      ]),
    ).toEqual({
      greetingProjectId: 'fresh',
      greetingDraftingProjectId: 'draft',
      greetingReadyProjectId: 'ready',
    });
  });

  it('состояние читает ПОСЛЕДНЯЯ сессия, а не любая подходящая', () => {
    // Запрос отдаёт сессии от новых к старым и берёт одну. Если бы
    // состояние выводилось из «была когда-нибудь сессия со статусом X»,
    // проект со сценарием попал бы и в «сценария нет» тоже — и сценарий
    // ждал бы кнопку, которой на экране давно нет.
    expect(
      greetingContext([
        p('a', SessionStatus.PROMPT_GENERATED, SessionStatus.CREATED),
      ]),
    ).toEqual({ greetingReadyProjectId: 'a' });
  });

  it('первый подходящий занимает поле, остальные не перетирают', () => {
    expect(greetingContext([p('first'), p('second')])).toEqual({
      greetingProjectId: 'first',
    });
  });

  it('проектов нет — контекст пуст, маршрут откажет НАЗВАННОЙ причиной', () => {
    expect(greetingContext([])).toEqual({});
  });
});
