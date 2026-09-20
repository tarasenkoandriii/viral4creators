import { IsBoolean } from 'class-validator';

/** PATCH /admin/creator-profiles/:id/featured — ТЗ §20 №19. */
export class SetFeaturedDto {
  @IsBoolean()
  isFeatured!: boolean;
}
