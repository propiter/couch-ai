FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY public ./public
ENV PORT=8080
ENV MEMORY_DIR=/data
RUN mkdir -p /data && chown -R node:node /data
EXPOSE 8080
USER node
VOLUME ["/data"]
CMD ["node", "server.js"]
