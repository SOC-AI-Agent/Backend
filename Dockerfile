# Debian-based image: bcrypt and Prisma both ship glibc prebuilds, so no
# native toolchain is needed at build time.
FROM node:24-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json .npmrc ./
COPY prisma ./prisma

# `npm ci` installs exactly what package-lock.json pins. `npm install` would
# re-resolve caret ranges at build time, which is how a hijacked release in the
# registry gets pulled into an image that "hasn't changed".
RUN npm ci

COPY . .
RUN npx prisma generate && npm run build

# Drop root: nothing in this service needs it at runtime.
RUN chown -R node:node /app
USER node

EXPOSE 8000

# APP_ROLE (api | worker) is set per service in docker-compose.yml.
CMD ["node", "dist/main.js"]
