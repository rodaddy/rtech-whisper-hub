FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
COPY drizzle/ ./drizzle/
# Optional server voice profile: mount a directory holding ref.wav and ref.txt
# and point VOICE_PROFILE_DIR at it (see docker-compose.example.yml).
USER node
EXPOSE 8096
CMD ["node","src/main.ts"]
