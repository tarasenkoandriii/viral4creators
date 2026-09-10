import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * PrismaModule
 *
 * Global so any module can inject PrismaService without importing this
 * module explicitly — mirrors how SessionService was already available
 * everywhere via AppModule's own @Global() decorator.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
