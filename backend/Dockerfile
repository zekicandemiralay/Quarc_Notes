FROM node:20-alpine
WORKDIR /app
# better-sqlite3 may have no prebuilt binary for this Node/musl combination;
# the toolchain lets npm compile it from source as a fallback (same as quarc-auth).
RUN apk add --no-cache python3 make g++
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
EXPOSE 3003
CMD ["node", "src/index.js"]
