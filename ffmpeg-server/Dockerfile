# ffmpeg-server — один Dockerfile, два образа из одной кодовой базы
# (бриф Р-FF-2, ТЗ §4, §6, §10):
#   --target api       HTTP API + диспетчер + downloader; БЕЗ ffmpeg;
#   --target executor  изолированный исполнитель ffmpeg/ffprobe (в compose:
#                      network_mode none, read_only, cap_drop ALL).
#
# Воспроизводимость: базовый образ фиксируется ДАЙДЖЕСТОМ, ffmpeg — точной
# версией Debian-пакета. Оба значения обязательны: без них сборка падает,
# а не тянет «что сейчас лежит под тегом». Как получить значения —
# docs/OPERATIONS.md §1 (`docker buildx imagetools inspect`, `apt-cache
# policy ffmpeg`); записываются в .env площадки и в отчёт этапа C.
ARG NODE_IMAGE=node:24-bookworm-slim
ARG NODE_DIGEST

# ── сборка TypeScript ──────────────────────────────────────────────────
FROM ${NODE_IMAGE}@${NODE_DIGEST} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ── общая основа рантайма ──────────────────────────────────────────────
FROM ${NODE_IMAGE}@${NODE_DIGEST} AS runtime
ENV NODE_ENV=production
# Общая группа workspace: API (uid 1000 node) пишет inputs/control,
# executor (uid 10001) — work/outputs/state. Каталоги попытки — 0770.
RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd -g 10000 ffwork \
  && useradd -u 10001 -g ffwork -M -d /nonexistent -s /usr/sbin/nologin ffexec \
  && usermod -a -G ffwork node \
  && mkdir -p /data /workspace /outputs /backup \
  && chown 1000:10000 /data /outputs /backup \
  && chown 1000:10000 /workspace \
  && chmod 0750 /data /outputs /backup \
  && chmod 2770 /workspace
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# ── api ────────────────────────────────────────────────────────────────
FROM runtime AS api
ARG IMAGE_DIGEST=""
ENV FFMPEG_SERVER_IMAGE_DIGEST=${IMAGE_DIGEST} \
    FFMPEG_SERVER_DATA_DIR=/data \
    FFMPEG_SERVER_WORKSPACE_ROOT=/workspace \
    FFMPEG_SERVER_OUTPUTS_ROOT=/outputs \
    FFMPEG_SERVER_PORT=8080
USER 1000:10000
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/main.js"]

# ── executor ───────────────────────────────────────────────────────────
FROM runtime AS executor
# Точная версия пакета bookworm (+security), например 7:5.1.x-0+deb12u1.
ARG FFMPEG_DEB_VERSION
RUN test -n "${FFMPEG_DEB_VERSION}" || (echo "FFMPEG_DEB_VERSION is required" >&2; exit 1) \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
       "ffmpeg=${FFMPEG_DEB_VERSION}" \
       fontconfig fonts-dejavu-core fonts-noto-core \
  && rm -rf /var/lib/apt/lists/*
# fontconfig: системные шрифты + ro-volume доп. шрифтов, алиас Arial →
# DejaVu Sans; кеш — в tmpfs (/tmp), корневая ФС read-only.
COPY docker/fonts.conf /etc/fonts/ffmpeg-server.conf
ENV FONTCONFIG_FILE=/etc/fonts/ffmpeg-server.conf
RUN fc-cache -f \
  && fc-match Arial | grep -q 'DejaVu Sans' \
  && fc-match 'Arial:lang=uk' | grep -q 'DejaVu Sans'
# Capability smoke при сборке (ТЗ §10): нужные энкодеры/фильтры есть и
# рендер libx264 + aac + libass с кириллицей/украинским проходит.
# Полный self-test (allowlist корпуса) повторяет executor при старте и
# отдаёт его итог в /api/ready.
RUN set -e; \
  ffmpeg -hide_banner -version | head -n 1; \
  for e in libx264 aac mjpeg png libmp3lame; do \
    ffmpeg -hide_banner -encoders | grep -Eq "^ [VAS][^ ]* +${e} " || { echo "missing encoder ${e}" >&2; exit 1; }; \
  done; \
  for f in subtitles ass drawtext loudnorm sidechaincompress amix aresample apad atrim setpts asetpts concat overlay setsar fps scale crop pad; do \
    ffmpeg -hide_banner -filters | grep -Eq "^ [T.][S.][C.]? +${f} " || { echo "missing filter ${f}" >&2; exit 1; }; \
  done; \
  fc-list :lang=uk family | grep -Eq 'DejaVu|Noto' || { echo "no Cyrillic/UK fonts" >&2; exit 1; }; \
  cd /tmp; \
  printf '1\n00:00:00,000 --> 00:00:01,000\nПривіт, світ! Їжак ґанок\n' > s.srt; \
  ffmpeg -hide_banner -v error -f lavfi -i testsrc=s=320x240:d=1 -f lavfi -i sine=d=1 \
    -vf "subtitles=s.srt:force_style='FontName=Arial',drawtext=text='Тест':font=Arial:fontcolor=white" -c:v libx264 -preset ultrafast \
    -pix_fmt yuv420p -c:a aac -shortest -y smoke.mp4; \
  test -s smoke.mp4; rm -f s.srt smoke.mp4
ENV WORKSPACE_ROOT=/workspace \
    FFMPEG_BIN=/usr/bin/ffmpeg \
    FFPROBE_BIN=/usr/bin/ffprobe \
    EXECUTOR_TMP_DIR=/tmp \
    HOME=/tmp \
    FONTCONFIG_FILE=/etc/fonts/ffmpeg-server.conf
# Лицензии FFmpeg/GPL-компонентов и шрифтов — /usr/share/doc/*/copyright
# (Debian сохраняет их в образе); список — README.md «Лицензии».
USER 10001:10000
# PID 1 — init Docker (`init: true` в compose): reap осиротевших процессов
# ffmpeg после kill(-pgid). Свой ENTRYPOINT не нужен.
ENTRYPOINT []
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/executor/main.js"]
