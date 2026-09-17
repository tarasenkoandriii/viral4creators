/**
 * Отпускание микрофона (этап 119, В-5.17).
 *
 * Проверяется не «функция вызывает stop», а три вещи, каждая из которых
 * раньше стоила пользователю горящего индикатора микрофона или записи
 * в состояние снятого экрана.
 */
import assert from 'node:assert/strict';
import {
  releaseMicrophone,
  type StoppableRecorder,
  type StoppableStream,
} from '../src/lib/mic-recorder';

function fakeRecorder(state = 'recording') {
  const calls: string[] = [];
  const rec: StoppableRecorder & { calls: string[] } = {
    state,
    onstop: () => calls.push('onstop сработал'),
    ondataavailable: () => calls.push('ondataavailable сработал'),
    stop() {
      calls.push('stop');
      // Настоящий MediaRecorder зовёт onstop именно здесь. Если
      // обработчик не снят заранее, он доделает работу снятого экрана.
      if (typeof rec.onstop === 'function')
        (rec.onstop as () => void).call(rec);
    },
    calls,
  };
  return rec;
}

function fakeStream(tracks = 2) {
  const stopped: number[] = [];
  const stream: StoppableStream & { stopped: number[] } = {
    getTracks: () =>
      Array.from({ length: tracks }, (_, i) => ({
        stop: () => stopped.push(i),
      })),
    stopped,
  };
  return stream;
}

// 1. Обработчики снимаются ДО остановки.
{
  const rec = fakeRecorder();
  releaseMicrophone(rec, fakeStream());
  assert.deepEqual(
    rec.calls,
    ['stop'],
    'onstop не должен сработать: иначе он уедет расшифровывать обрывок ' +
      'записи и писать результат в состояние уже снятого экрана'
  );
  assert.equal(rec.onstop, null);
  assert.equal(rec.ondataavailable, null);
}

// 2. Дорожки останавливаются — именно они держат микрофон.
{
  const stream = fakeStream(3);
  releaseMicrophone(fakeRecorder(), stream);
  assert.deepEqual(
    stream.stopped,
    [0, 1, 2],
    'не остановленная дорожка — это горящий индикатор микрофона до конца сессии'
  );
}

// 3. Запись, которую человек уже остановил, не трогаем вовсе.
{
  const rec = fakeRecorder('inactive');
  const stream = fakeStream(2);
  const interrupted = releaseMicrophone(rec, stream);
  assert.equal(interrupted, false, 'прерывать было нечего');
  assert.deepEqual(
    rec.calls,
    [],
    'stop() у неактивной записи бросает InvalidStateError, а зовут эту ' +
      'функцию из уборки эффекта, где бросать некуда'
  );
  assert.equal(
    typeof rec.onstop,
    'function',
    'события `MediaRecorder` приходят асинхронно: между «Стоп» и `onstop` ' +
      'есть окно, и уход с экрана в это окно не должен отнимать у ' +
      'человека уже законченную им запись'
  );
  assert.deepEqual(
    stream.stopped,
    [],
    'дорожки остановит собственный `onstop` записи — обрывать их посреди ' +
      'доставки последнего куска значило бы рискнуть самой записью'
  );
}

// 3a. Прерванная запись — наоборот, докладывает об этом вызывающему:
//     по этому ответу экран решает, выбрасывать ли накопленные куски.
{
  const interrupted = releaseMicrophone(fakeRecorder('recording'), null);
  assert.equal(interrupted, true);
}

// 4. Дорожки отпускаются даже без записи: «Стоп» уже нажали, а поток
//    остался — ровно тот случай, когда микрофон и горел.
{
  const stream = fakeStream(1);
  releaseMicrophone(null, stream);
  assert.deepEqual(stream.stopped, [0]);
}

// 5. Ничего нет — ничего не происходит (уборка эффекта до первой записи).
releaseMicrophone(null, null);
releaseMicrophone(undefined, undefined);

console.log('mic-recorder: 6 cases ok');
