FROM v4c-ffmpeg-api-bounded:b52bf39a
USER 0:0
WORKDIR /app/blob-backup
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY sync.cjs ./
USER 1000:10000
