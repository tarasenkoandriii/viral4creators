import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { applyStoryPublicHeaders } from './story-access.guard';

/** ST3-S-06: noindex + no-referrer on every `/story-gift/*` answer. */
@Module({})
export class StoryPublicHeadersModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    applyStoryPublicHeaders(consumer);
  }
}
