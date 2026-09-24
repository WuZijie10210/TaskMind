FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY web ./web
COPY vite.config.js ./
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY app ./app
COPY db ./db
COPY --from=build /app/static ./static
USER node
EXPOSE 3000
CMD ["sh", "-c", "node app/migrate.cjs && exec node app/server.js"]
