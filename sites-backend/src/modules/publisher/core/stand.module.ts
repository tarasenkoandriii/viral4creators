/**
 * AI Publisher — модуль стенда сквозных маршрутов (Р-PUB-Z2-21, интеграция
 * Z-2b). Только стенд `scripts/publisher-e2e.sh`.
 *
 * `forRoot(env)` решает при сборке приложения:
 *  - `publisherStandClock(env).enabled` (флаг `PUBLISHER_STAND_CLOCK=true` И
 *    `NODE_ENV=development|test` И не Vercel) — ставит часы стенда
 *    (`core/clock.ts`) и РЕГИСТРИРУЕТ маршрут управления
 *    `GET|POST /__stand/publisher/clock` (доступ — `Authorization: Bearer
 *    <CRON_SECRET>`, без секрета — 503 даже на dev-стенде);
 *  - иначе маршрута нет вовсе (404 роутера, как у любого неизвестного
 *    пути), часы системные; флаг, запрошенный вне стенда, — предупреждение
 *    в журнале (`PublisherStand`), старт не падает.
 *
 * Путь — вне `/publisher/*`: это не маршрут продукта (реестр контрактов
 * `contracts/*_ROUTES` и `z-isolation` его не знают и знать не должны).
 */
import {
  BadRequestException,
  Body,
  Controller,
  type DynamicModule,
  Get,
  Headers,
  HttpCode,
  Logger,
  Module,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { publisherStandClock } from '../../../config/publisher-env';
import { assertCronSecret } from '../../../common/cron-secret';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';
import {
  installStandClock,
  standClock,
  type StandClock,
  StandClockError,
  type StandClockState,
} from './clock';

export const PUB_STAND_INIT = 'PUB_STAND_INIT';
export const PUB_STAND_CLOCK_PATH = '/__stand/publisher/clock';

/** Секрет крона обязателен: у часов стенда нет dev-обхода `ALLOW_DEV_AUTH`. */
function assertStandSecret(
  authHeader: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!env.CRON_SECRET?.trim())
    throw new ServiceUnavailableException(
      'CRON_SECRET не задан — часы стенда закрыты',
    );
  assertCronSecret(authHeader, env);
}

function clockOrFail(): StandClock {
  const c = standClock();
  if (!c) throw new ServiceUnavailableException('часы стенда не стоят');
  return c;
}

interface ClockBody {
  at?: unknown;
  advanceMs?: unknown;
  freeze?: unknown;
}

@Controller('__stand/publisher')
@PublicRoute(
  'стенд E2E Publisher: часы стенда по CRON_SECRET; маршрут есть только при PUBLISHER_STAND_CLOCK вне production',
)
export class PublisherStandClockController {
  @Get('clock')
  get(@Headers('authorization') auth?: string): StandClockState {
    assertStandSecret(auth);
    return clockOrFail().state();
  }

  /** `{at?: ISO, advanceMs?: number, freeze?: boolean}` — только вперёд. */
  @Post('clock')
  @HttpCode(200)
  set(
    @Headers('authorization') auth: string | undefined,
    @Body() raw: unknown,
  ): StandClockState {
    assertStandSecret(auth);
    const b = (raw && typeof raw === 'object' ? raw : {}) as ClockBody;
    const at =
      typeof b.at === 'string' && !Number.isNaN(Date.parse(b.at))
        ? new Date(b.at)
        : undefined;
    const advanceMs =
      typeof b.advanceMs === 'number' && Number.isFinite(b.advanceMs)
        ? b.advanceMs
        : undefined;
    if ((at === undefined) === (advanceMs === undefined))
      throw new BadRequestException('нужно ровно одно: at (ISO) или advanceMs');
    const clock = clockOrFail();
    try {
      clock.set({ at, advanceMs, freeze: b.freeze === true });
    } catch (e) {
      if (e instanceof StandClockError)
        throw new BadRequestException(e.message);
      throw e;
    }
    return clock.state();
  }
}

@Module({})
export class PublisherStandModule {
  static forRoot(env: NodeJS.ProcessEnv = process.env): DynamicModule {
    const clock = publisherStandClock(env);
    return {
      module: PublisherStandModule,
      controllers: clock.enabled ? [PublisherStandClockController] : [],
      providers: [
        {
          provide: PUB_STAND_INIT,
          useFactory: () => {
            const log = new Logger('PublisherStand');
            if (clock.enabled) {
              installStandClock();
              log.warn(
                `часы стенда включены (${PUB_STAND_CLOCK_PATH}) — только стенд E2E`,
              );
            } else if (clock.problem) {
              log.warn(clock.problem);
            }
            return { clock: clock.enabled };
          },
        },
      ],
    };
  }
}
