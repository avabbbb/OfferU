# OfferU Vite development container.
# Desktop releases are built and embedded by Tauri, not served by this image.

FROM node:22-alpine AS dev

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm config set registry https://registry.npmmirror.com/ \
  && npm ci --no-audit --no-fund

COPY . .

EXPOSE 7410

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
