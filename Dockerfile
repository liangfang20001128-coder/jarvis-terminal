FROM node:22-alpine
WORKDIR /app
COPY package.json agent-server.mjs ./
ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "agent-server.mjs"]
