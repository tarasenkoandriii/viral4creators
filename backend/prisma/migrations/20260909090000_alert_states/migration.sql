-- Этап 47 (ТЗ §28.3, В-2.5): дедупликация тревог служебного канала живёт
-- в базе, а не в памяти экземпляра функции — экземпляров на Vercel много,
-- и падающий провайдер разлетается по всем сразу.
CREATE TABLE "alert_states" (
    "fingerprint" TEXT NOT NULL,
    "lastSentAt" TIMESTAMP(3) NOT NULL,
    "suppressed" INTEGER NOT NULL DEFAULT 0,
    "reported" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "alert_states_pkey" PRIMARY KEY ("fingerprint")
);
