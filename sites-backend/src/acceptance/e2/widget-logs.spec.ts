/**
 * Приёмка Э2 п.6 (часть W2): «в логах нет текста сообщений» — перехват
 * логгера Nest и консоли на ПОЛНОМ проходе публичных маршрутов виджета
 * (сессия, чат SSE и JSON, повтор, стрим, state, оценка, лид, handoff,
 * forget, предпросмотр, ошибки валидации и отказы гварда). В логах не
 * должно быть: вопроса, телефона/e-mail, полей лида, visitor-token,
 * resumeKey, токена и сессии предпросмотра (ТЗ §6.6; контракт §9 п.4 —
 * «даже в debug»: перехватываются все уровни).
 */
import { Logger, type LoggerService } from '@nestjs/common';
import { randomBytes } from 'crypto';
import * as request from 'supertest';
import {
  WIDGET_VISITOR_TOKEN_HEADER,
  widgetResumeCookieName,
} from '../../brand';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { sha256Hex } from '../../modules/assist-widget/site-access';
import {
  TMA_ORIGIN,
  W_ORIGIN,
  domain,
  newRequestId,
  startWidgetStack,
  widgetFixture,
  type WidgetStack,
} from '../../modules/assist-widget/testing/widget-stack.testing';

// Поднятие стенда и HTTP-серии под нагрузкой CI дольше 5 с по умолчанию.
jest.setTimeout(30_000);

class CaptureLogger implements LoggerService {
  readonly lines: string[] = [];
  private push(level: string, args: unknown[]) {
    this.lines.push(
      `${level} ${args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`,
    );
  }
  log(...a: unknown[]) {
    this.push('log', a);
  }
  error(...a: unknown[]) {
    this.push('error', a);
  }
  warn(...a: unknown[]) {
    this.push('warn', a);
  }
  debug(...a: unknown[]) {
    this.push('debug', a);
  }
  verbose(...a: unknown[]) {
    this.push('verbose', a);
  }
  fatal(...a: unknown[]) {
    this.push('fatal', a);
  }
}

describeDb(
  'Э2 п.6 (W2): в логах маршрутов виджета нет текста и секретов',
  () => {
    let stack: WidgetStack;
    const cap = new CaptureLogger();
    const consoleLines: string[] = [];
    const srv = () => stack.app.getHttpServer();

    beforeAll(async () => {
      for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
        jest.spyOn(console, m).mockImplementation((...a: unknown[]) => {
          consoleLines.push(a.map(String).join(' '));
        });
      }
      stack = await startWidgetStack();
      // Перехват на ПРОТОТИПЕ Logger: каждый `new Logger(ctx)` сервисов и
      // фильтра идёт через эти методы, кто бы ни был статическим логгером
      // (тестовый модуль Nest ставит свой TestingLogger при compile()).
      for (const m of [
        'log',
        'error',
        'warn',
        'debug',
        'verbose',
        'fatal',
      ] as const) {
        jest
          .spyOn(Logger.prototype, m)
          .mockImplementation((...a: unknown[]) => cap[m](...a));
      }
      Logger.overrideLogger(cap);
    });
    afterAll(async () => {
      await stack?.close();
      jest.restoreAllMocks();
      Logger.overrideLogger(false);
    });

    it('полный проход маршрутов — ни одного секрета в логах', async () => {
      const PHONE = '+380 67 123 45 67';
      const EMAIL = 'olena.secret@example.org';
      const QUESTION = `Перезвоните мне на ${PHONE} или ${EMAIL}, сколько стоит доставка?`;
      const NAME = 'Олена-Тестова-Ім’я';
      const COMMENT = 'Мій приватний коментар до заявки';
      stack.chat.answer = `Записал ваш номер ${PHONE} и почту ${EMAIL}`;

      const d = domain();
      const f = await widgetFixture(stack, [{ host: d }]);
      const parent = `https://${d}`;
      const s = await request(srv())
        .post('/widget/v1/session')
        .set('Origin', W_ORIGIN)
        .set('X-Forwarded-For', '198.18.7.7')
        .send({ pk: f.pk, parentOrigin: parent })
        .expect(200);
      const token = s.body.data.visitorToken as string;
      const resumeKey = s.body.data.resumeKey as string;
      const auth = (m: 'get' | 'post', p: string) =>
        request(srv())
          [m](p)
          .set('Origin', W_ORIGIN)
          .set(WIDGET_VISITOR_TOKEN_HEADER, token);

      // Возврат по указателю (cookie) — ещё одна сессия.
      await request(srv())
        .post('/widget/v1/session')
        .set('Origin', W_ORIGIN)
        .set('Cookie', `${widgetResumeCookieName(f.pk)}=${resumeKey}`)
        .send({ pk: f.pk, parentOrigin: parent, resumeKey })
        .expect(200);

      const crid = newRequestId();
      const sse = await auth('post', '/widget/v1/chat')
        .send({
          conversationId: null,
          clientRequestId: crid,
          question: QUESTION,
          page: {
            url: `${parent}/p?email=${EMAIL}`,
            title: `Страница ${NAME}`,
          },
          context: { note: COMMENT },
          uiLang: 'uk',
        })
        .expect(200);
      const convId = /"conversationId":"([^"]+)"/.exec(sse.text)![1];
      const msgId = /"messageId":"([^"]+)"/.exec(sse.text)![1];
      // Повтор (JSON), продолжение стрима, состояние.
      await auth('post', '/widget/v1/chat')
        .set('Accept', 'application/json')
        .send({
          conversationId: convId,
          clientRequestId: crid,
          question: QUESTION,
          page: null,
          context: null,
          uiLang: 'uk',
        })
        .expect(200);
      await auth('get', `/widget/v1/messages/${msgId}/stream?from=0`).expect(
        200,
      );
      await auth('get', '/widget/v1/state').expect(200);
      await auth('post', '/widget/v1/feedback')
        .send({ messageId: msgId, rating: -1 })
        .expect(200);
      // Ошибки: длинный вопрос, лишнее поле, без согласия, чужие поля.
      await auth('post', '/widget/v1/chat')
        .set('Accept', 'application/json')
        .send({
          conversationId: null,
          clientRequestId: newRequestId(),
          question: `${QUESTION} ${'я'.repeat(700)}`,
          page: null,
          context: null,
          uiLang: null,
        })
        .expect(400);
      await auth('post', '/widget/v1/chat')
        .send({ question: QUESTION, secret: EMAIL, clientRequestId: crid })
        .expect(400);
      await auth('post', '/widget/v1/lead')
        .send({
          conversationId: convId,
          fields: { name: NAME, phone: PHONE, email: EMAIL, comment: COMMENT },
          consent: false,
          uiLang: 'uk',
          pageUrl: null,
        })
        .expect(400);
      await auth('post', '/widget/v1/lead')
        .send({
          conversationId: convId,
          fields: { name: NAME, phone: PHONE, email: EMAIL, comment: COMMENT },
          consent: true,
          uiLang: 'uk',
          pageUrl: `${parent}/c?phone=${PHONE}`,
        })
        .expect(200);
      await auth('post', '/widget/v1/lead')
        .send({
          conversationId: convId,
          fields: { password: EMAIL },
          consent: true,
          uiLang: 'uk',
          pageUrl: null,
        })
        .expect(400);
      await auth('post', '/widget/v1/handoff').expect(200);
      // Сбой конвейера с текстом провайдера.
      stack.chat.failWith = new Error(`провайдер: ${QUESTION}`);
      await auth('post', '/widget/v1/chat')
        .send({
          conversationId: null,
          clientRequestId: newRequestId(),
          question: QUESTION,
          page: null,
          context: null,
          uiLang: null,
        })
        .expect(200);
      stack.chat.failWith = null;
      // Предпросмотр: токен и сессия.
      const pv = randomBytes(32).toString('base64url');
      await stack.prisma.assistSitePreviewToken.create({
        data: {
          accountId: f.accountId,
          siteId: f.siteId,
          tokenHash: sha256Hex(pv),
          purpose: 'tma',
          draft: { schema: 1 },
          createdByTelegramId: 1n,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      const ex = await request(srv())
        .post('/widget/v1/preview/exchange')
        .set('Origin', W_ORIGIN)
        .send({ pk: f.pk, token: pv, parentOrigin: TMA_ORIGIN })
        .expect(200);
      await request(srv())
        .post('/widget/v1/preview/exchange')
        .set('Origin', W_ORIGIN)
        .send({ pk: f.pk, token: pv, parentOrigin: TMA_ORIGIN })
        .expect(403);
      const previewSession = ex.body.data.previewSession as string;
      await request(srv())
        .post('/widget/v1/session')
        .set('Origin', W_ORIGIN)
        .send({ pk: f.pk, parentOrigin: TMA_ORIGIN, previewSession })
        .expect(200);
      // Отказы гварда и токена.
      await request(srv())
        .post('/widget/v1/session')
        .set('Origin', W_ORIGIN)
        .send({ pk: f.pk, parentOrigin: `https://${EMAIL.split('@')[1]}` })
        .expect(403);
      await request(srv())
        .get('/widget/v1/state')
        .set('Origin', W_ORIGIN)
        .set(WIDGET_VISITOR_TOKEN_HEADER, `${token}x`)
        .expect(401);
      await auth('post', '/widget/v1/forget').expect(200);

      const all = [...cap.lines, ...consoleLines].join('\n');
      // Логи вообще пишутся (иначе тест проверял бы пустоту).
      expect(cap.lines.some((l) => l.includes(`site=${f.siteId}`))).toBe(true);
      for (const secret of [
        QUESTION,
        PHONE,
        PHONE.replace(/\s/g, ''),
        EMAIL,
        NAME,
        COMMENT,
        token,
        token.split('.')[1],
        resumeKey,
        pv,
        previewSession,
        stack.chat.answer,
      ]) {
        expect({ secret, found: all.includes(secret) }).toEqual({
          secret,
          found: false,
        });
      }
      // Фраза «Перезвоните» — часть вопроса — тоже нигде.
      expect(all).not.toMatch(/Перезвоните|приватный|Записал/);
    });
  },
);
