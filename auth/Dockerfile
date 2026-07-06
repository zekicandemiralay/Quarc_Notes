FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY migrate-from-music.js ./
EXPOSE 3002
CMD ["node", "src/index.js"]
