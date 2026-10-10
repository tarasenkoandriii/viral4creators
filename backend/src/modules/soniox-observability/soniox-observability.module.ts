import { sonioxContext, sonioxRequestContext } from './soniox-context';
import {
  CallHandler,
  ExecutionContext,
  Global,
  Injectable,
  Module,
  NestInterceptor,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Observable } from 'rxjs';
import { SonioxObservability } from './soniox-observability.service';
@Injectable()
class SonioxContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    return new Observable((subscriber) =>
      sonioxContext.run(sonioxRequestContext(req), () =>
        next.handle().subscribe(subscriber),
      ),
    );
  }
}
@Global()
@Module({
  providers: [
    SonioxObservability,
    { provide: APP_INTERCEPTOR, useClass: SonioxContextInterceptor },
  ],
  exports: [SonioxObservability],
})
export class SonioxObservabilityModule {}
