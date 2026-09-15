/**
 * SessionsModule
 *
 * Handles session creation, retrieval and deletion endpoints.
 *
 * No imports of its own: `SessionService` is already available globally
 * (`AppModule`). Up to этап 88.2, `DELETE /sessions/:id` also deleted the
 * session's files in Blob synchronously, which needed `StorageModule`
 * imported here explicitly (`BlobService` isn't global, unlike
 * `SessionService`). Этап 89 turned that delete into a soft-delete
 * (`SessionService.softDeleteSession` just sets `deletedAt`) — physical
 * row + Blob cleanup moved to `purgeSoftDeletedSessions()`, run from the
 * cron (`CronModule`, which already has `StorageModule`) — so this module
 * no longer touches Blob at all.
 */

import { Module } from '@nestjs/common';
import { SessionsController } from './sessions.controller';

@Module({
  controllers: [SessionsController],
})
export class SessionsModule {}
