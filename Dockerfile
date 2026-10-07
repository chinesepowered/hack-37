FROM node:22-alpine
WORKDIR /app
RUN npm install -g pnpm@11.22.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
