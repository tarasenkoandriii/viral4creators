// Plain assertions runnable with `npx tsx scripts/client-site-steps.test.ts`.
//
// Шаги обучалки — «Тонкая красная линия», этап 3. Проверяется не
// отрисовка, а правила: куда можно, что считается пройденным и что
// восстанавливается из адреса.

import {
  clientSiteFactsOf,
  clientSiteStageFromUrl,
  clientSiteStepOfStage,
  clientSiteSteps,
  clientSiteUrlStep,
  type ClientSiteStepId,
} from '../src/lib/client-site-steps';
import { toStepsView } from '../src/lib/wizard-steps';

const LABELS: Record<ClientSiteStepId, string> = {
  url: 'Ссылка',
  record: 'Запись',
  review: 'Просмотр',
};

const draft = (status: string, frames: number) => ({
  status,
  roundScreenshots: Array.from({ length: frames }, (_, i) => `f${i}`),
});

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}
function eq(actual: unknown, expected: unknown, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg} ожидалось ${b}, получено ${a}`);
}
const view = (d: ReturnType<typeof draft> | null, at: ClientSiteStepId) =>
  toStepsView(clientSiteSteps(clientSiteFactsOf(d), LABELS), at);

check('без черновика доступен только ввод ссылки', () => {
  eq(view(null, 'url').selectable, [true, false, false]);
});

check('черновик есть — назад к ссылке нельзя', () => {
  // Это не навигация: возврат означает удаление записи вместе с
  // шифрованными учётными данными, и делается отдельной кнопкой с
  // подтверждением.
  eq(view(draft('DRAFTING', 2), 'record').selectable[0], false);
});

check('запись и просмотр ходят друг к другу свободно', () => {
  const v = view(draft('DRAFTING', 3), 'record');
  eq([v.selectable[1], v.selectable[2]], [true, true]);
});

check('просмотр недоступен, пока не записано ни кадра', () => {
  eq(view(draft('DRAFTING', 0), 'record').selectable[2], false);
});

check('отправленный на модерацию черновик не пускает в запись', () => {
  // `status !== 'DRAFTING'` — редактировать нечего; смотреть можно.
  const v = view(draft('PENDING_REVIEW', 4), 'review');
  eq([v.selectable[1], v.selectable[2]], [false, true]);
});

check('завершённость задана явно, а не позицией', () => {
  // Стоим на записи, а просмотр уже пройден: черновик вернулся с
  // модерации. Позиционное правило `i < current` объявило бы его
  // непройденным.
  const v = view(draft('REJECTED', 4), 'record');
  eq(v.done, [true, true, true]);
});

check('состояние экрана и шаг — не одно и то же', () => {
  eq(clientSiteStepOfStage('page'), 'record');
  eq(clientSiteStepOfStage('review'), 'review');
  eq(clientSiteStepOfStage('url'), 'url');
  // `loading`, а не `null`: в `toStepsView` null означает «всё
  // пройдено», и перепутать эти два смысла стоило бы степпера,
  // нарисованного целиком пройденным на экране загрузки.
  eq(clientSiteStepOfStage('loading'), 'loading');
});

check('первый шаг — голый маршрут, без сегмента', () => {
  // Ссылки, выданные до появления сегмента, обязаны работать.
  eq(clientSiteUrlStep('url'), undefined);
  eq(clientSiteUrlStep('loading'), undefined);
  eq(clientSiteUrlStep('page'), 'record');
  eq(clientSiteUrlStep('review'), 'review');
});

check('адрес записи открывается на просмотре', () => {
  // Экран записи рисуется по снимку страницы, который приходит только
  // ответом сервера на раунд. После перезагрузки его нет, а звать
  // `refresh` самим — значит поднять браузерную сессию на сервере без
  // просьбы человека.
  eq(
    clientSiteStageFromUrl('record', clientSiteFactsOf(draft('DRAFTING', 2))),
    'review'
  );
  eq(
    clientSiteStageFromUrl('review', clientSiteFactsOf(draft('DRAFTING', 2))),
    'review'
  );
});

check('без черновика адрес шага ничего не значит', () => {
  eq(clientSiteStageFromUrl('review', clientSiteFactsOf(null)), 'url');
});

check('пустой черновик открывается на вводе ссылки', () => {
  // Заведён, но ни одного кадра — показывать в просмотре нечего.
  eq(
    clientSiteStageFromUrl(undefined, clientSiteFactsOf(draft('DRAFTING', 0))),
    'url'
  );
});

if (failed) {
  console.error(`\n${failed} проверок упало`);
  process.exit(1);
}
console.log('\n11 проверок пройдено');
