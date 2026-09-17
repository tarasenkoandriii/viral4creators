import { parseClientMessage } from '../src/client-message';

/**
 * Регрессия аудита этапа 108. Главная из находок: до валидации
 * сообщение `{"type":"auth"}` БЕЗ поля token доходило до
 * `createHash().update(undefined)`, который бросает синхронно внутри
 * обработчика `ws.on('message')` — то есть роняло весь процесс реле
 * вместе с сессиями всех остальных пользователей, и для этого не
 * требовалось знать streamToken (апгрейд WS его не спрашивает).
 */
describe('parseClientMessage — auth', () => {
  it('принимает корректное auth-сообщение', () => {
    expect(parseClientMessage('{"type":"auth","token":"abc"}')).toEqual({
      type: 'auth',
      token: 'abc',
    });
  });

  it('отклоняет auth без токена (кейс, ронявший процесс)', () => {
    expect(parseClientMessage('{"type":"auth"}')).toBeNull();
  });

  it('отклоняет auth с нестроковым токеном', () => {
    expect(parseClientMessage('{"type":"auth","token":123}')).toBeNull();
    expect(parseClientMessage('{"type":"auth","token":null}')).toBeNull();
    expect(parseClientMessage('{"type":"auth","token":{}}')).toBeNull();
  });

  it('отклоняет auth с пустым токеном', () => {
    expect(parseClientMessage('{"type":"auth","token":""}')).toBeNull();
  });
});

describe('parseClientMessage — mouse', () => {
  it('принимает корректное событие мыши', () => {
    expect(
      parseClientMessage(
        '{"type":"mouse","event":"mousePressed","x":10,"y":20,"button":"left"}',
      ),
    ).toEqual({
      type: 'mouse',
      event: 'mousePressed',
      x: 10,
      y: 20,
      button: 'left',
      deltaX: undefined,
      deltaY: undefined,
    });
  });

  it('отклоняет неизвестный тип события (ушёл бы в CDP как есть)', () => {
    expect(
      parseClientMessage('{"type":"mouse","event":"drop table","x":1,"y":1}'),
    ).toBeNull();
  });

  it('отклоняет нечисловые/нефинитные координаты', () => {
    for (const bad of [
      '{"type":"mouse","event":"mouseMoved","x":"10","y":20}',
      '{"type":"mouse","event":"mouseMoved","x":null,"y":20}',
      '{"type":"mouse","event":"mouseMoved","y":20}',
    ]) {
      expect(parseClientMessage(bad)).toBeNull();
    }
  });

  it('отклоняет неизвестную кнопку', () => {
    expect(
      parseClientMessage(
        '{"type":"mouse","event":"mousePressed","x":1,"y":1,"button":"forward"}',
      ),
    ).toBeNull();
  });

  it('принимает колесо с дельтами', () => {
    expect(
      parseClientMessage(
        '{"type":"mouse","event":"mouseWheel","x":1,"y":2,"deltaX":0,"deltaY":-120}',
      ),
    ).toMatchObject({ event: 'mouseWheel', deltaY: -120 });
  });
});

describe('parseClientMessage — key/resize/ping', () => {
  it('принимает корректное событие клавиатуры', () => {
    expect(
      parseClientMessage(
        '{"type":"key","event":"char","key":"a","code":"KeyA","text":"a"}',
      ),
    ).toEqual({
      type: 'key',
      event: 'char',
      key: 'a',
      code: 'KeyA',
      text: 'a',
    });
  });

  it('отклоняет key без обязательных строковых полей', () => {
    expect(parseClientMessage('{"type":"key","event":"keyDown"}')).toBeNull();
    expect(
      parseClientMessage('{"type":"key","event":"keyDown","key":1,"code":"a"}'),
    ).toBeNull();
  });

  it('принимает разумный resize и отклоняет абсурдный', () => {
    expect(
      parseClientMessage('{"type":"resize","width":390,"height":844}'),
    ).toEqual({ type: 'resize', width: 390, height: 844 });
    for (const bad of [
      '{"type":"resize","width":0,"height":844}',
      '{"type":"resize","width":-5,"height":844}',
      '{"type":"resize","width":999999,"height":844}',
      '{"type":"resize","width":"390","height":844}',
    ]) {
      expect(parseClientMessage(bad)).toBeNull();
    }
  });

  it('принимает ping', () => {
    expect(parseClientMessage('{"type":"ping"}')).toEqual({ type: 'ping' });
  });
});

describe('parseClientMessage — мусор', () => {
  it('отклоняет невалидный JSON, массив, примитив и неизвестный тип', () => {
    for (const bad of [
      'не json вовсе',
      '[1,2,3]',
      '"строка"',
      'null',
      '{"type":"exec","cmd":"rm -rf /"}',
      '{}',
    ]) {
      expect(parseClientMessage(bad)).toBeNull();
    }
  });
});
