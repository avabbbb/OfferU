# OfferU Vite development container.
# Desktop releases are built and embedded by Tauri, not served by this image.

FROM node:22-alpine AS dev

WORKDIR /app

# curl is required by the HEALTHCHECK below and is not bundled with alpine.
RUN apk add --no-cache curl

COPY package.json package-lock.json* ./

RUN npm config set registry https://registry.npmmirror.com/ \
  && npm ci --no-audit --no-fund

COPY . .

EXPOSE 7410

USER node

HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -f http://localhost:7410 || exit 1

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
