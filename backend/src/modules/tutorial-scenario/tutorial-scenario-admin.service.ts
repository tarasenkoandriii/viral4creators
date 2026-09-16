/**
 * TutorialScenarioAdminService — список сценариев и явное одобрение
 * costly=true перед автоматическим исполнением (§4.11 ТЗ, этап 94).
 * Тот же приём, что `AssistantAdminService`/`PublicationService.approve`
 * (см. их доккомментарии): читающая часть отдаёт «как в базе», пишущая
 * — только флаг одобрения, ничего не пересчитывает заново (прикидка
 * стоимости уже посчитана генератором, §4.11 — «число не гарантия, а
 * прикидка ДЛЯ РЕШЕНИЯ человека», не то, что стоит трогать на
 * одобрении).
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface TutorialScenarioListFilter {
  subjectKey?: string;
  locale?: string;
  costly?: boolean;
  approved?: boolean;
  page: number;
  pageSize: number;
}

@Injectable()
export class TutorialScenarioAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async list(filter: TutorialScenarioListFilter) {
    const where = {
      subjectKey: filter.subjectKey || undefined,
      locale: filter.locale || undefined,
      costly: filter.costly,
      approved: filter.approved,
    };
    const [rows, total] = await Promise.all([
      this.prisma.tutorialScenario.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
      }),
      this.prisma.tutorialScenario.count({ where }),
    ]);
    return { rows, total, page: filter.page, pageSize: filter.pageSize };
  }

  /**
   * Одобряет трату на costly=true сценарий (§4.11). Идемпотентно — если
   * уже одобрен, просто возвращает текущую строку, не переписывает
   * `approvedBy`/`approvedAt` второй раз (кто одобрил ПЕРВЫМ — то и
   * есть решение, не последний нажавший кнопку).
   */
  async approve(id: string, approvedBy: string) {
    const row = await this.prisma.tutorialScenario.findUnique({
      where: { id },
    });
    if (!row) throw new NotFoundException('Сценарий не найден');
    if (!row.costly) {
      throw new BadRequestException(
        'Этот сценарий бесплатный — одобрение траты ему не требуется',
      );
    }
    if (row.approved) return row;
    return this.prisma.tutorialScenario.update({
      where: { id },
      data: { approved: true, approvedBy, approvedAt: new Date() },
    });
  }
}
