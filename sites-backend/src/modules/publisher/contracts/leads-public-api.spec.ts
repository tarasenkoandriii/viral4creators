/**
 * Контракты маршрутов P-D (`leads-api.ts`, `public-api.ts`) ↔ контроллеры
 * пакета: метод, путь, действие матрицы (кабинет) / `@PublicRoute`
 * (публичные). Карта событий по умолчанию ≡ API (`eventMapIssues`).
 */
import { enumerateControllers } from '../core/route-enumerator';
import { PUB_PERMISSIONS } from '../core/roles';
import { PublisherLeadContactsController } from '../leads/contacts.controller';
import { PublisherLeadsController } from '../leads/leads.controller';
import { PublisherIntakeController } from '../public/intake-public.controller';
import { LEADS_ROUTES } from './leads-api';
import { DEFAULT_PARAMETER_VALUES } from './parameters';
import { PUBLIC_ROUTES, eventMapIssues } from './public-api';

describe('contracts/leads-api ↔ контроллеры кабинета P-D', () => {
  it('LEADS_ROUTES = маршруты контроллеров (метод, путь, действие), каждое действие — из матрицы §4.2', () => {
    const fromControllers = enumerateControllers([
      PublisherLeadsController as never,
      PublisherLeadContactsController as never,
    ])
      .map((r) => `${r.method} ${r.path} ${JSON.stringify(r.pubActions)}`)
      .sort();
    const fromContract = Object.values(LEADS_ROUTES)
      .map(
        (r) =>
          `${r.method} ${r.path} ${JSON.stringify(Array.isArray(r.action) ? r.action : [r.action])}`,
      )
      .sort();
    expect(fromControllers).toEqual(fromContract);
    for (const r of Object.values(LEADS_ROUTES)) {
      for (const a of Array.isArray(r.action) ? r.action : [r.action]) {
        expect(
          Object.prototype.hasOwnProperty.call(PUB_PERMISSIONS, a as string),
        ).toBe(true);
      }
    }
  });

  it('раскрытие контакта и заметок — только POST (без opKey) с правом lead.contact.reveal (PO, SA); прежний GET — 405 (Р-PUB-Z2-25)', () => {
    for (const r of [LEADS_ROUTES.revealContact, LEADS_ROUTES.revealNotes]) {
      expect(r).toMatchObject({
        method: 'POST',
        mutation: false,
        action: 'lead.contact.reveal',
        status: 200,
      });
    }
    for (const r of [
      LEADS_ROUTES.revealContactGetRemoved,
      LEADS_ROUTES.revealNotesGetRemoved,
    ]) {
      expect(r).toMatchObject({ method: 'GET', status: 405 });
    }
    expect(PUB_PERMISSIONS['lead.contact.reveal'].roles).toEqual([
      'product_owner',
      'sales',
    ]);
  });
});

describe('contracts/public-api ↔ публичный контроллер P-D', () => {
  it('PUBLIC_ROUTES = маршруты контроллера; все публичные (@PublicRoute), без действия матрицы', () => {
    const routes = enumerateControllers([PublisherIntakeController as never]);
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      Object.values(PUBLIC_ROUTES)
        .map((r) => `${r.method} ${r.path}`)
        .sort(),
    );
    for (const r of routes) {
      expect(r.publicReason).toEqual(expect.any(String));
      expect(r.pubActions).toBeUndefined();
    }
  });

  it('карта событий по умолчанию совпадает с API; лишнее поле, чужое событие и не тот сборщик — находятся', () => {
    expect(eventMapIssues(DEFAULT_PARAMETER_VALUES.event_map)).toEqual([]);
    const bad = structuredClone(DEFAULT_PARAMETER_VALUES.event_map);
    bad.events[0].fields.push('email');
    bad.events[2].collector = 'own_endpoint';
    bad.events.push({ ...bad.events[0], name: 'scroll' as never });
    bad.events[1].excludeTest = false;
    expect(eventMapIssues(bad)).toEqual([
      'event_map.events[0].fields: «email» API не собирает',
      'event_map.events[1].excludeTest: тестовые события исключаются',
      'event_map.events[2].collector: ожидается server',
      'event_map.events[3].name: «scroll» нет в API',
    ]);
    expect(eventMapIssues({ version: '1', events: [] })).toEqual([
      'event_map: нет события content_view',
      'event_map: нет события cta_click',
      'event_map: нет события lead_submit_success',
    ]);
    expect(eventMapIssues(null)).toEqual(['event_map.events: не список']);
  });
});
