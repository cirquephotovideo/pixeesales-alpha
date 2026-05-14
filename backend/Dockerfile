FROM node:22-alpine

WORKDIR /app

# Deps natives pour better-sqlite3 + pdfkit
RUN apk add --no-cache python3 make g++ curl

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

# Persistance SQLite + uploaded PDFs
VOLUME ["/data"]
ENV DB_PATH=/data/pixeesales.db
ENV PDF_DIR=/data/pdfs

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:4000/health || exit 1

CMD ["node", "src/server.js"]
