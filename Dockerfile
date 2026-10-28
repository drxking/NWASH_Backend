FROM node:24-alpine

RUN apk add --no-cache openssl
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY prisma ./prisma
RUN npm run db:generate

COPY src ./src
COPY scripts ./scripts
EXPOSE 8000
CMD ["npm", "start"]
