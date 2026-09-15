/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { AssistantController } from './assistant.controller';
import { AssistantChatRequestDto } from './dto/assistant-chat-request.dto';

async function* gen(events: any[]) {
  for (const e of events) yield e;
}

function fakeRes() {
  const chunks: string[] = [];
  const res: any = {
    _status: 200,
    writableEnded: false,
    writeHead: jest.fn(),
    write: jest.fn((s: string) => {
      chunks.push(s);
      return true;
    }),
    end: jest.fn(() => {
      res.writableEnded = true;
    }),
    status: jest.fn((code: number) => {
      res._status = code;
      return res;
    }),
    json: jest.fn(),
  };
  return { res, chunks };
}

function build(events: any[]) {
  const assistant = { streamChat: jest.fn(() => gen(events)) };
  const settings = { get: jest.fn() };
  const prisma = {
    assistantEvent: { createMany: jest.fn().mockResolvedValue({}) },
  };
  const controller = new AssistantController(
    assistant as any,
    settings as any,
    prisma as any,
  );
  return { controller, assistant, prisma };
}

const dto: AssistantChatRequestDto = {
  locale: 'ru',
  page: 'how-it-works',
  messages: [{ role: 'user', content: 'Привет' }],
};

describe('AssistantController.chat — §4.3', () => {
  it('без text/event-stream в Accept — собирает JSON {text, actions, usage}', async () => {
    const { controller } = build([
      { type: 'token', t: 'Привет ' },
      { type: 'token', t: 'мир' },
      { type: 'actions', items: [{ kind: 'open-app' }] },
      { type: 'done', usage: { in: 10, out: 5, cached: 0 } },
    ]);
    const { res } = fakeRes();
    const req: any = { headers: { accept: 'application/json' } };
    await controller.chat(dto, req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      text: 'Привет мир',
      actions: [{ kind: 'open-app' }],
      usage: { in: 10, out: 5, cached: 0 },
    });
  });

  it('JSON-фолбэк: budget_exhausted → статус 503 и {error}', async () => {
    const { controller } = build([
      { type: 'error', code: 'budget_exhausted', message: 'позже' },
    ]);
    const { res } = fakeRes();
    const req: any = { headers: {} };
    await controller.chat(dto, req, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'budget_exhausted', message: 'позже' },
      text: '',
      actions: [],
      usage: { in: 0, out: 0, cached: 0 },
    });
  });

  // Найдено доп. аудитом (MEDIUM): частичный текст, накопленный до
  // обрыва стрима, теперь не теряется в JSON-запасном варианте — то же
  // самое SSE-путь уже показывает построчно к моменту `event: error`.
  it('JSON-фолбэк: ошибка после части токенов — {error} несёт и накопленный text/actions', async () => {
    const { controller } = build([
      { type: 'token', t: 'начало ответа' },
      { type: 'actions', items: [{ kind: 'open-app' }] },
      { type: 'error', code: 'upstream', message: 'сбой' },
    ]);
    const { res } = fakeRes();
    const req: any = { headers: {} };
    await controller.chat(dto, req, res);
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'upstream', message: 'сбой' },
      text: 'начало ответа',
      actions: [{ kind: 'open-app' }],
      usage: { in: 0, out: 0, cached: 0 },
    });
  });

  it('JSON-фолбэк: rate_limited → статус 429', async () => {
    const { controller } = build([
      { type: 'error', code: 'rate_limited', message: 'подождите' },
    ]);
    const { res } = fakeRes();
    const req: any = { headers: {} };
    await controller.chat(dto, req, res);
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('Accept: text/event-stream — пишет SSE-события с правильными заголовками', async () => {
    const { controller } = build([
      { type: 'token', t: 'ответ' },
      { type: 'done', usage: { in: 1, out: 1, cached: 0 } },
    ]);
    const { res, chunks } = fakeRes();
    const req: any = { headers: { accept: 'text/event-stream' } };
    await controller.chat(dto, req, res);

    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ 'Content-Type': 'text/event-stream' }),
    );
    const body = chunks.join('');
    expect(body).toContain('event: token');
    expect(body).toContain('data: {"t":"ответ"}');
    expect(body).toContain('event: done');
    expect(res.end).toHaveBeenCalled();
  });
});
