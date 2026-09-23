import { readdirSync } from 'fs';
import { join } from 'path';
import {
  HINT_ACTIONS_DELIMITER,
  HINT_DOC_SLUGS,
  parseHintActions,
  splitHintActions,
} from './hint-actions';

const STEPS = ['url', 'record', 'review'];

describe('действия под подсказкой (§5.7)', () => {
  it('без блока действий текст остаётся целым', () => {
    expect(splitHintActions('Проверьте ссылку.')).toEqual({
      text: 'Проверьте ссылку.',
      actionsJson: null,
    });
  });

  it('блок отделяется от текста, а не остаётся в нём', () => {
    const full = `Совет.\n${HINT_ACTIONS_DELIMITER}\n{"items":[]}`;
    const split = splitHintActions(full);
    expect(split.text).toBe('Совет.');
    expect(split.actionsJson).toBe('{"items":[]}');
  });

  it('шаг не из этого сценария отбрасывается, ответ остаётся', () => {
    // Кнопка на несуществующий шаг хуже отсутствия кнопки: человек
    // жмёт, ничего не происходит, и виноват продукт.
    const actions = parseHintActions(
      '{"items":[{"kind":"goto-step","stepId":"выдумка"},{"kind":"goto-step","stepId":"review"}]}',
      STEPS,
    );
    expect(actions).toEqual([{ kind: 'goto-step', stepId: 'review' }]);
  });

  it('модель не может задать подпись или адрес', () => {
    // Их подставляет сервер. Иначе однажды придуманная ссылка будет
    // выглядеть настоящей.
    const actions = parseHintActions(
      '{"items":[{"kind":"goto-step","stepId":"record","label":"Жми","url":"https://зло"}]}',
      STEPS,
    );
    expect(actions).toEqual([{ kind: 'goto-step', stepId: 'record' }]);
  });

  it('документ — только из белого списка', () => {
    expect(
      parseHintActions('{"items":[{"kind":"open-doc","slug":"offer"}]}', STEPS),
    ).toEqual([]);
    expect(
      parseHintActions(
        '{"items":[{"kind":"open-doc","slug":"offer"}]}',
        STEPS,
        ['offer'],
      ),
    ).toEqual([{ kind: 'open-doc', slug: 'offer' }]);
  });

  it('лендинговые виды действий сюда не проходят', () => {
    // `open-app`, `plan`, `faq`, `video` осмысленны на сайте и
    // бессмысленны внутри мини-аппа.
    expect(
      parseHintActions(
        '{"items":[{"kind":"open-app"},{"kind":"plan","planId":"PREMIUM"},{"kind":"video","subjectKey":"x"}]}',
        STEPS,
      ),
    ).toEqual([]);
  });

  it('больше трёх действий не отдаём', () => {
    const items = Array.from({ length: 6 }, () => ({
      kind: 'goto-step',
      stepId: 'review',
    }));
    expect(parseHintActions(JSON.stringify({ items }), STEPS)).toHaveLength(3);
  });

  it('испорченный JSON не роняет подсказку', () => {
    expect(parseHintActions('{это не json', STEPS)).toEqual([]);
    expect(parseHintActions('{"items":"строка"}', STEPS)).toEqual([]);
  });

  it('белый список документов совпадает с тем, что реально отдаётся', () => {
    // Слаг — это адрес страницы `/legal/<slug>`, а страницы собираются
    // из `doc/legal/*.md` (`scripts/sync-legal.mjs`). Переименовали
    // документ — кнопка советника ведёт в 404, и заметить это иначе
    // негде: невалидные действия отбрасываются МОЛЧА, а этот слаг
    // валиден по своему списку.
    const dir = join(__dirname, '..', '..', '..', '..', 'doc', 'legal');
    const onDisk = readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
    expect([...HINT_DOC_SLUGS].sort()).toEqual(onDisk);
  });
});
