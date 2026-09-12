-- Общий key-value для настроек, редактируемых оператором из админки без
-- редеплоя (доп. запрос владельца продукта: ручной селектор «Озвучка по
-- умолчанию» — elevenlabs/resemble/veo, veo как всегда доступный
-- бесплатный фоллбек, когда на балансе ElevenLabs/Resemble нет денег).
CREATE TABLE "platform_settings" (
    "key"       TEXT NOT NULL,
    "value"     TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);
