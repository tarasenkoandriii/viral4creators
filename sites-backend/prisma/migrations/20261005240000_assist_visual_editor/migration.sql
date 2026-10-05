-- Э6-тер «Визуальный редактор голосового управления» ИИ-помощника — ядро
-- (а)+(б)+(в)+(г): голосовая карта «Сайта». ТЗ помощника §5-кватер
-- (Р-51…Р-54), решения Э6-тер Р-73…Р-82 (§12.1); план, строка Э6-тер.
--
-- Пишется РУКАМИ (база — вывод движка схем Prisma, дальше комментарии,
-- представление и права); CI сверяет со schema.prisma (`migrate diff
-- --exit-code`; представления движок схем не сравнивает). Предыдущие
-- миграции не трогаем. Карта «Админки» (`assist_admin_voice_map*`) — после
-- Э6-бис (б), своими таблицами (К-9), не здесь. Режим «Снимок» (таблица
-- снимков) — с браузерным воркером Ш3 (В-58), не здесь.
--
-- Что здесь:
--  * assist_site_voice_maps — черновик карты (JSON: цели, шаблоны страниц,
--    термины) с ревизией, номер опубликованной версии, счётчик «Сказать
--    сейчас» за сутки;
--  * assist_site_voice_map_versions — неизменяемые версии (ворота кода,
--    публикация только человеком в TMA, откат — новой версией);
--  * assist_site_voice_map_changes — журнал операций черновика;
--  * assist_site_voice_map_editor_sessions — одноразовая ссылка редактора
--    (10 мин) и сессия (30 мин скользящих, ≤ 4 ч), токены — SHA-256;
--  * assist_site_ui_action_log: `mapKey` (цель карты шага) и `mapMiss`
--    (команда назвала цель карты, а в снимке её нет — сигнал Т-4);
--  * представление `assist_site_voice_map_published` — ТОЛЬКО опубликованная
--    версия; роли assist_public — SELECT на него и ничего на таблицы карты.
--  * (аудит Э6-бис (б) (8), инвариант «Админка → Сайт», ТЗ §10)
--    `site_hosts.assistRole` public|admin — зеркало
--    `assist_admin_settings.adminHostIds`, которое держат триггеры (обе
--    стороны: смена настроек «Админки» и вставка хоста); роли assist_public
--    — колоночный SELECT только на неё: настроек «Админки» роль по-прежнему
--    не читает, а публичный виджет «Сайта» на admin-хосте не работает;
--  * (аудит Э6-тер (2)) потолки запроса публикации из сессии редактора:
--    счётчик на сайт за сутки и отметка последнего запроса сессии.

-- AlterTable
ALTER TABLE "assist_site_ui_action_log" ADD COLUMN     "mapKey" TEXT,
ADD COLUMN     "mapMiss" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "assist_site_voice_maps" (
    "siteId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "publishedVersion" INTEGER NOT NULL DEFAULT 0,
    "versionSeq" INTEGER NOT NULL DEFAULT 0,
    "draftRevision" INTEGER NOT NULL DEFAULT 0,
    "draft" JSONB NOT NULL,
    "platformTemplate" TEXT,
    "tryDay" TEXT,
    "tryCount" INTEGER NOT NULL DEFAULT 0,
    "publishReqDay" TEXT,
    "publishReqCount" INTEGER NOT NULL DEFAULT 0,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_site_voice_maps_pkey" PRIMARY KEY ("siteId")
);

-- CreateTable
CREATE TABLE "assist_site_voice_map_versions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "gateReport" JSONB,
    "rollbackOf" INTEGER,
    "requestedBy" TEXT NOT NULL,
    "requestedVia" TEXT NOT NULL,
    "publishedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "assist_site_voice_map_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_voice_map_changes" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "actor" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "op" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_voice_map_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_voice_map_editor_sessions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "parentOrigin" TEXT NOT NULL,
    "pagePath" TEXT NOT NULL DEFAULT '/',
    "focusKey" TEXT,
    "linkTokenHash" TEXT NOT NULL,
    "sessionTokenHash" TEXT,
    "linkExpiresAt" TIMESTAMP(3) NOT NULL,
    "exchangedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "absoluteExpiresAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "lastPublishRequestAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_voice_map_editor_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assist_site_voice_maps_accountId_idx" ON "assist_site_voice_maps"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_voice_maps_siteId_accountId_key" ON "assist_site_voice_maps"("siteId", "accountId");

-- CreateIndex
CREATE INDEX "assist_site_voice_map_versions_accountId_idx" ON "assist_site_voice_map_versions"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_voice_map_versions_siteId_number_key" ON "assist_site_voice_map_versions"("siteId", "number");

-- CreateIndex
CREATE INDEX "assist_site_voice_map_changes_siteId_createdAt_idx" ON "assist_site_voice_map_changes"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "assist_site_voice_map_changes_accountId_idx" ON "assist_site_voice_map_changes"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_voice_map_editor_sessions_linkTokenHash_key" ON "assist_site_voice_map_editor_sessions"("linkTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_voice_map_editor_sessions_sessionTokenHash_key" ON "assist_site_voice_map_editor_sessions"("sessionTokenHash");

-- CreateIndex
CREATE INDEX "assist_site_voice_map_editor_sessions_siteId_idx" ON "assist_site_voice_map_editor_sessions"("siteId");

-- CreateIndex
CREATE INDEX "assist_site_voice_map_editor_sessions_accountId_idx" ON "assist_site_voice_map_editor_sessions"("accountId");

-- AddForeignKey
ALTER TABLE "assist_site_voice_maps" ADD CONSTRAINT "assist_site_voice_maps_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_voice_map_versions" ADD CONSTRAINT "assist_site_voice_map_versions_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_voice_map_changes" ADD CONSTRAINT "assist_site_voice_map_changes_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_voice_map_editor_sessions" ADD CONSTRAINT "assist_site_voice_map_editor_sessions_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;



-- ══ Представление для публичного кода (§5-кватер.9 «Изоляция», §5-кватер.13) ══
-- Роль виджета не видит ни черновика, ни версий на проверке, ни журнала, ни
-- сессий редактора: только содержимое ОПУБЛИКОВАННОЙ версии. Имена и
-- синонимы в нём есть — прямой путь и блок <voice_map> промпта строит
-- сервер под этой ролью (Р-75); в ответы /widget/v1/* они не уходят.
-- `security_barrier`: условия представления применяются раньше условий
-- запроса роли.
CREATE VIEW "assist_site_voice_map_published" WITH (security_barrier = true) AS
SELECT m."siteId", v."number" AS "version", v."content"
  FROM "assist_site_voice_maps" m
  JOIN "assist_site_voice_map_versions" v
    ON v."siteId" = m."siteId" AND v."number" = m."publishedVersion"
   AND v."status" = 'published';


-- ══ Роль assist_public (виджет) — минимум ══

-- Карта: только представление опубликованной версии.
GRANT SELECT ON "assist_site_voice_map_published" TO assist_public;

-- Журнал шагов: новые колонки `mapKey`/`mapMiss` покрыты табличным INSERT
-- миграции _assist_voice_control (журнал только дописывается).


-- ══ Роль хоста «Сайт/Админка» для публичного кода (аудит Э6-бис (б) (8)) ══
-- Источник правды — настройки «Админки» (`adminHostIds`, Э7, выкачено);
-- здесь только зеркало в таблице хостов ядра. Держит его БАЗА, а не код:
-- любой путь записи `adminHostIds` (сервис режима, ручная правка, будущий
-- код) сразу меняет роль хоста, и гвард виджета отказывает на следующем же
-- запросе. Хост, удалённый из `adminHostIds`, снова `public`.

-- AlterTable
ALTER TABLE "site_hosts" ADD COLUMN     "assistRole" TEXT NOT NULL DEFAULT 'public';

-- Схема — та же, что у таблицы триггера (адаптер search_path не ставит).
CREATE OR REPLACE FUNCTION "site_hosts_assist_role_sync"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  sid TEXT;
  ids TEXT[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    sid := OLD."siteId";
    ids := ARRAY[]::TEXT[];
  ELSE
    sid := NEW."siteId";
    ids := COALESCE(NEW."adminHostIds", ARRAY[]::TEXT[]);
  END IF;
  EXECUTE format(
    'UPDATE %I."site_hosts" h
        SET "assistRole" = CASE WHEN h."id" = ANY ($2) THEN ''admin'' ELSE ''public'' END
      WHERE h."siteId" = $1
        AND h."assistRole" IS DISTINCT FROM
            (CASE WHEN h."id" = ANY ($2) THEN ''admin'' ELSE ''public'' END)',
    TG_TABLE_SCHEMA)
    USING sid, ids;
  -- Смена сайта у строки настроек (siteId — ключ, но на всякий случай):
  -- хосты прежнего сайта — снова public.
  IF TG_OP = 'UPDATE' THEN
    IF OLD."siteId" IS DISTINCT FROM NEW."siteId" THEN
      EXECUTE format(
        'UPDATE %I."site_hosts" SET "assistRole" = ''public''
          WHERE "siteId" = $1 AND "assistRole" <> ''public''',
        TG_TABLE_SCHEMA)
        USING OLD."siteId";
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER "site_hosts_assist_role_sync"
  AFTER INSERT OR DELETE OR UPDATE OF "adminHostIds", "siteId" ON "assist_admin_settings"
  FOR EACH ROW EXECUTE FUNCTION "site_hosts_assist_role_sync"();

-- Роль у хоста задаёт только триггер выше: вставка/правка строки хоста не
-- может назначить `assistRole` сама (код ядра колонку не пишет) — роль
-- пересчитывается по настройкам «Админки» её сайта.
CREATE OR REPLACE FUNCTION "site_hosts_assist_role_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  is_admin BOOLEAN;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW; -- запись из site_hosts_assist_role_sync
  END IF;
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %I."assist_admin_settings" s
      WHERE s."siteId" = $1 AND $2 = ANY (s."adminHostIds"))',
    TG_TABLE_SCHEMA)
    INTO is_admin
    USING NEW."siteId", NEW."id";
  NEW."assistRole" := CASE WHEN is_admin THEN 'admin' ELSE 'public' END;
  RETURN NEW;
END $$;

CREATE TRIGGER "site_hosts_assist_role_guard"
  BEFORE INSERT OR UPDATE OF "assistRole", "siteId", "id" ON "site_hosts"
  FOR EACH ROW EXECUTE FUNCTION "site_hosts_assist_role_guard"();

-- Перенос: хосты, уже отмеченные хостами «Админки» (Э7 выкачен).
UPDATE "site_hosts" h SET "assistRole" = 'admin'
  FROM "assist_admin_settings" s
 WHERE s."siteId" = h."siteId" AND h."id" = ANY (s."adminHostIds");

-- Роль виджета: только эта колонка (к прежнему колоночному GRANT ядра).
GRANT SELECT ("assistRole") ON "site_hosts" TO assist_public;
