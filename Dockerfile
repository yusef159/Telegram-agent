FROM --platform=$TARGETPLATFORM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache python3 make g++ tini

FROM base AS deps
COPY package*.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM base AS prod-deps
COPY package*.json ./
RUN npm ci --omit=dev

FROM --platform=$TARGETPLATFORM node:22-alpine AS runner
WORKDIR /app
RUN apk add --no-cache tini
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY .env.example ./.env.example
RUN mkdir -p /app/data
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
