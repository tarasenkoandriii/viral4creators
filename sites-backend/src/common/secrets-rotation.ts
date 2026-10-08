/**
 * Перешифровка данных под ключом `ASSIST_SECRETS_KEY` прежних версий
 * текущим (№60, Р-З10-12). Порядок ротации — `doc/DEPLOYMENT.md`:
 *  1. новый ключ → `ASSIST_SECRETS_KEY`, версия → `ASSIST_SECRETS_KEY_VERSION`
 *     (v2, …), прежний — в `ASSIST_SECRETS_KEYS_OLD=v1:<ключ>` → деплой;
 *  2. `npm run secrets:rotate` (dry-run: сколько строк каких версий) →
 *     `-- --apply` (перешифровать) → повторный dry-run: старых версий 0;
 *  3. `remaining` = 0 и прошло 2 суток (visitor-token — 24 ч, `assistRef` —
 *     2 суток, билеты голоса — минуты) — убрать прежний ключ из env.
 *
 * Перешифровываются: поля лида `assist_site_leads.fieldsEnc` и его
 * `identityEnc`, секреты интеграций `assist_site_integrations.secretEnc`,
 * `identify` передачи `assist_site_handoffs.identityEnc`, recToken
 * `assist_subscriptions.recTokenEnc`, секреты «Админки» (свой формат
 * `as1.<версия>.…` + колонка версии, AAD — кабинет/сайт/владелец/назначение;
 * `admin-secrets-crypto.ts`): `assist_admin_settings.identitySecretEnc`,
 * `assist_admin_connectors.secretEnc` и `.signSecretEnc` — шифр и колонка
 * версии пишутся одним условным UPDATE. Только СЧИТАЮТСЯ живые значения
 * планов `assist_site_ui_plans.liveValues` (план живёт ≤ 10 минут, затем их
 * обнуляет сервис или крон ретенции): прежние версии входят в `remaining`.
 * Строка, которую не открыл ни один ключ, — в `failed` и не трогается
 * (ключ потерян или порча; данные не восстановить). `remaining` = 0 — и
 * только тогда — прежний ключ можно убирать (с учётом сроков токенов).
 *
 * Запись условная (`WHERE id AND столбец = прежнее значение`): строку,
 * которую в это время переписал сервис, скрипт не затирает. Повторный
 * запуск безопасен. В отчёте только счётчики — ни id, ни текста.
 */
import {
  encryptLeadFields,
  leadKey,
  openLeadFields,
} from '../modules/assist-site-chat/lead-crypto';
import {
  encryptIdentity,
  openHandoffIdentity,
} from '../modules/assist-site-handoff/public/identity-crypto';
import {
  openPaymentToken,
  sealPaymentToken,
} from '../modules/assist-billing/billing-env';
import {
  encryptSecret,
  integrationsKey,
  openIntegrationSecret,
} from '../modules/assist-analytics/integrations.service';
import {
  encryptIdentity as encryptLeadIdentity,
  identityKey,
  openLeadIdentity,
} from '../modules/assist-analytics/public/identity-crypto';
import {
  AdminSecretsError,
  loadAdminKeyring,
  openAdminSecret,
  sealAdminSecret,
  type AdminKeyring,
  type AdminSecretPurpose,
} from '../modules/assist-admin-mode/admin-secrets-crypto';
import { IDENTITY_SECRET_OWNER } from '../modules/assist-admin-mode/admin-mode.service';
import { parseSecretsKeyring, splitKeyVersion } from './secrets-keyring';

/** Минимум клиента Prisma (основная роль, владелец схемы). */
export interface RotationDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export interface RotationTableReport {
  /** Строк с шифром всего. */
  total: number;
  /** Сколько строк каждой версии ключа (по факту расшифровки). */
  versions: Record<string, number>;
  /** Уже текущим ключом и в каноничной форме. */
  current: number;
  /** Перешифровано (`apply`) или будет перешифровано (dry-run). */
  rewritten: number;
  /** Не открылись ни одним ключом связки. */
  failed: number;
  /** Строку переписал сервис между чтением и записью — пропущена. */
  raced: number;
}

export interface RotationReport {
  currentVersion: string;
  configProblem: string | null;
  leads: RotationTableReport;
  /** `assist_site_leads.identityEnc` (ключ identify аналитики). */
  leadIdentities: RotationTableReport;
  /** `assist_site_integrations.secretEnc` (секреты вебхука/identify/API). */
  integrations: RotationTableReport;
  handoffs: RotationTableReport;
  subscriptions: RotationTableReport;
  /** «Админка»: секрет подписи employee-JWT сайта. */
  adminIdentity: RotationTableReport;
  /** «Админка»: секрет API коннектора. */
  adminConnectorSecrets: RotationTableReport;
  /** «Админка»: секрет подписи запросов коннектора (Э8). */
  adminConnectorSigning: RotationTableReport;
  /** Живые значения планов по версии ключа (только счёт). */
  liveValues: Record<string, number>;
  /**
   * Строк, которые держат прежний ключ или не открылись: во всех
   * перешифровываемых таблицах + `liveValues` прежних версий. Пока > 0 —
   * прежний ключ из env не убирать.
   */
  remaining: number;
}

interface TableSpec {
  table: string;
  id: string;
  column: string;
  /** SQL-выражение связки (AAD) строки; по умолчанию — id. */
  aadSql?: string;
  open(stored: string, aad: string): { version: string } | null;
  /** Новая строка текущим ключом. */
  reseal(stored: string, aad: string): string | null;
}

const S = '"sites"';
const BATCH = 200;

function emptyTable(): RotationTableReport {
  return {
    total: 0,
    versions: {},
    current: 0,
    rewritten: 0,
    failed: 0,
    raced: 0,
  };
}

/** Тесты на общей базе — только свои кабинеты (как `BillingTickScope`). */
export interface RotationScope {
  accountIds: string[];
}

const scopeSql = (scope: RotationScope | undefined, n: number) =>
  scope ? ` AND "accountId" = ANY($${n}::text[])` : '';
const scopeArgs = (scope: RotationScope | undefined) =>
  scope ? [scope.accountIds] : [];

async function rotateTable(
  db: RotationDb,
  spec: TableSpec,
  currentVersion: string,
  apply: boolean,
  scope: RotationScope | undefined,
): Promise<RotationTableReport> {
  const out = emptyTable();
  let after = '';
  for (;;) {
    const rows = await db.$queryRawUnsafe<
      Array<{ id: string; enc: string; aad: string }>
    >(
      `SELECT "${spec.id}" AS id, "${spec.column}" AS enc,
              ${spec.aadSql ?? `"${spec.id}"`} AS aad FROM ${S}."${spec.table}"
        WHERE "${spec.column}" IS NOT NULL AND "${spec.id}" > $1${scopeSql(scope, 2)}
        ORDER BY "${spec.id}" LIMIT ${BATCH}`,
      after,
      ...scopeArgs(scope),
    );
    if (!rows.length) break;
    after = rows[rows.length - 1].id;
    for (const row of rows) {
      out.total++;
      const opened = spec.open(row.enc, row.aad);
      if (!opened) {
        out.failed++;
        continue;
      }
      out.versions[opened.version] = (out.versions[opened.version] ?? 0) + 1;
      // Каноничная форма: текущий ключ, без префикса (Р-З10-25).
      const canonical =
        opened.version === currentVersion && !splitKeyVersion(row.enc).prefixed;
      if (canonical) {
        out.current++;
        continue;
      }
      if (!apply) {
        out.rewritten++;
        continue;
      }
      const next = spec.reseal(row.enc, row.aad);
      if (!next) {
        out.failed++;
        continue;
      }
      const n = await db.$executeRawUnsafe(
        `UPDATE ${S}."${spec.table}" SET "${spec.column}" = $1
          WHERE "${spec.id}" = $2 AND "${spec.column}" = $3`,
        next,
        row.id,
        row.enc,
      );
      if (n === 1) out.rewritten++;
      else out.raced++;
    }
  }
  return out;
}

interface AdminColumnSpec {
  table: 'assist_admin_settings' | 'assist_admin_connectors';
  id: string;
  column: string;
  versionColumn: string;
  purpose: AdminSecretPurpose;
  /** SQL-выражение `ownerId` AAD (id коннектора или константа). */
  ownerSql: string;
}

/**
 * Секреты «Админки»: открыть своей версией (колонка = префикс, иначе
 * отказ), запечатать текущей; шифр и колонка версии — одним условным
 * UPDATE (по прежнему шифру).
 */
async function rotateAdminColumn(
  db: RotationDb,
  spec: AdminColumnSpec,
  keyring: AdminKeyring | null,
  apply: boolean,
  scope: RotationScope | undefined,
): Promise<RotationTableReport> {
  const out = emptyTable();
  let after = '';
  for (;;) {
    const rows = await db.$queryRawUnsafe<
      Array<{
        id: string;
        accountId: string;
        siteId: string;
        ownerId: string;
        enc: string;
        ver: string | null;
      }>
    >(
      `SELECT "${spec.id}" AS id, "accountId", "siteId", ${spec.ownerSql} AS "ownerId",
              "${spec.column}" AS enc, "${spec.versionColumn}" AS ver
         FROM ${S}."${spec.table}"
        WHERE "${spec.column}" IS NOT NULL AND "${spec.id}" > $1${scopeSql(scope, 2)}
        ORDER BY "${spec.id}" LIMIT ${BATCH}`,
      after,
      ...scopeArgs(scope),
    );
    if (!rows.length) break;
    after = rows[rows.length - 1].id;
    for (const row of rows) {
      out.total++;
      const ctx = {
        accountId: row.accountId,
        siteId: row.siteId,
        ownerId: row.ownerId,
        purpose: spec.purpose,
      };
      let plain: string;
      try {
        if (!keyring) throw new AdminSecretsError('not_configured', 'нет');
        plain = openAdminSecret(
          { ciphertext: row.enc, keyVersion: row.ver },
          ctx,
          keyring,
        );
      } catch {
        out.failed++;
        continue;
      }
      const version = row.ver as string;
      out.versions[version] = (out.versions[version] ?? 0) + 1;
      if (version === keyring!.current) {
        out.current++;
        continue;
      }
      if (!apply) {
        out.rewritten++;
        continue;
      }
      const sealed = sealAdminSecret(plain, ctx, keyring!);
      const n = await db.$executeRawUnsafe(
        `UPDATE ${S}."${spec.table}"
            SET "${spec.column}" = $1, "${spec.versionColumn}" = $2
          WHERE "${spec.id}" = $3 AND "${spec.column}" = $4`,
        sealed.ciphertext,
        sealed.keyVersion,
        row.id,
        row.enc,
      );
      if (n === 1) out.rewritten++;
      else out.raced++;
    }
  }
  return out;
}

async function countByVersion(
  db: RotationDb,
  sql: string,
  scope: RotationScope | undefined,
): Promise<Record<string, number>> {
  const rows = await db.$queryRawUnsafe<Array<{ v: string | null; n: number }>>(
    sql,
    ...scopeArgs(scope),
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.v ?? '(нет)'] = Number(r.n);
  return out;
}

export async function rotateAssistSecrets(
  db: RotationDb,
  opts: { apply: boolean; env?: NodeJS.ProcessEnv; scope?: RotationScope },
): Promise<RotationReport> {
  const env = opts.env ?? process.env;
  const { keyring, problem } = parseSecretsKeyring(env);
  const keys = leadKey(env);
  if (!keyring || !keys) {
    throw new Error('ASSIST_SECRETS_KEY не задан — перешифровывать нечем');
  }
  // Кривой список прежних = только текущий ключ: строки старых версий
  // попали бы в failed — не пишем ничего, пока env не исправлен.
  if (problem && opts.apply) {
    throw new Error(
      `конфигурация ключей с ошибкой (${problem}) — --apply запрещён; dry-run покажет, что видно`,
    );
  }
  const current = keyring.current;
  const leads = await rotateTable(
    db,
    {
      table: 'assist_site_leads',
      id: 'id',
      column: 'fieldsEnc',
      open: (enc, id) => openLeadFields(enc, id, keys),
      reseal: (enc, id) => {
        const o = openLeadFields(enc, id, keys);
        return o ? encryptLeadFields(o.value, id, keys) : null;
      },
    },
    current,
    opts.apply,
    opts.scope,
  );
  const idKeys = identityKey(env)!;
  const leadIdentities = await rotateTable(
    db,
    {
      table: 'assist_site_leads',
      id: 'id',
      column: 'identityEnc',
      open: (enc, id) => openLeadIdentity(enc, id, idKeys),
      reseal: (enc, id) => {
        const o = openLeadIdentity(enc, id, idKeys);
        return o ? encryptLeadIdentity(o.value, id, idKeys) : null;
      },
    },
    current,
    opts.apply,
    opts.scope,
  );
  const intKeys = integrationsKey(env)!;
  const integrations = await rotateTable(
    db,
    {
      table: 'assist_site_integrations',
      id: 'id',
      column: 'secretEnc',
      aadSql: `"siteId" || ':' || "kind"`,
      open: (enc, aad) => openIntegrationSecret(enc, aad, intKeys),
      reseal: (enc, aad) => {
        const o = openIntegrationSecret(enc, aad, intKeys);
        return o ? encryptSecret(o.value, aad, intKeys) : null;
      },
    },
    current,
    opts.apply,
    opts.scope,
  );
  const handoffs = await rotateTable(
    db,
    {
      table: 'assist_site_handoffs',
      id: 'id',
      column: 'identityEnc',
      open: (enc, id) => openHandoffIdentity(enc, id, keys),
      reseal: (enc, id) => {
        const o = openHandoffIdentity(enc, id, keys);
        return o ? encryptIdentity(o.value, id, keys) : null;
      },
    },
    current,
    opts.apply,
    opts.scope,
  );
  const subscriptions = await rotateTable(
    db,
    {
      table: 'assist_subscriptions',
      id: 'accountId',
      column: 'recTokenEnc',
      open: (enc) => openPaymentToken(enc, env),
      reseal: (enc) => {
        const o = openPaymentToken(enc, env);
        return o ? sealPaymentToken(o.value, env) : null;
      },
    },
    current,
    opts.apply,
    opts.scope,
  );
  // Связка «Админки» — её же разбор (строгий: кривой env — отказ, тогда
  // все строки в failed, а --apply выше уже запрещён).
  let adminKeyring: AdminKeyring | null = null;
  try {
    adminKeyring = loadAdminKeyring(env);
  } catch {
    adminKeyring = null;
  }
  const adminIdentity = await rotateAdminColumn(
    db,
    {
      table: 'assist_admin_settings',
      id: 'siteId',
      column: 'identitySecretEnc',
      versionColumn: 'identityKeyVersion',
      purpose: 'identity-secret',
      ownerSql: `'${IDENTITY_SECRET_OWNER}'::text`,
    },
    adminKeyring,
    opts.apply,
    opts.scope,
  );
  const adminConnectorSecrets = await rotateAdminColumn(
    db,
    {
      table: 'assist_admin_connectors',
      id: 'id',
      column: 'secretEnc',
      versionColumn: 'secretKeyVersion',
      purpose: 'connector-secret',
      ownerSql: '"id"',
    },
    adminKeyring,
    opts.apply,
    opts.scope,
  );
  const adminConnectorSigning = await rotateAdminColumn(
    db,
    {
      table: 'assist_admin_connectors',
      id: 'id',
      column: 'signSecretEnc',
      versionColumn: 'signKeyVersion',
      purpose: 'connector-signing',
      ownerSql: '"id"',
    },
    adminKeyring,
    opts.apply,
    opts.scope,
  );
  const liveValues = await countByVersion(
    db,
    `SELECT COALESCE("liveValues"->>'kv', 'открытый') AS v, count(*)::int AS n
       FROM ${S}."assist_site_ui_plans" WHERE "liveValues" IS NOT NULL${scopeSql(opts.scope, 1)}
       GROUP BY 1 ORDER BY 1`,
    opts.scope,
  );
  const stale = (t: RotationTableReport) =>
    opts.apply ? t.failed + t.raced : t.rewritten + t.failed;
  const liveStale = Object.entries(liveValues)
    .filter(([v]) => v !== current && v !== 'открытый')
    .reduce((n, [, c]) => n + c, 0);
  return {
    currentVersion: current,
    configProblem: problem,
    leads,
    leadIdentities,
    integrations,
    handoffs,
    subscriptions,
    adminIdentity,
    adminConnectorSecrets,
    adminConnectorSigning,
    liveValues,
    remaining:
      stale(leads) +
      stale(leadIdentities) +
      stale(integrations) +
      stale(handoffs) +
      stale(subscriptions) +
      stale(adminIdentity) +
      stale(adminConnectorSecrets) +
      stale(adminConnectorSigning) +
      liveStale,
  };
}
