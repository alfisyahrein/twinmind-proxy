FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY twinmind_proxy.js ./

ENV PORT=8790
EXPOSE 8790

# No npm dependencies — the proxy is pure stdlib (http, fs, path).
CMD ["node", "twinmind_proxy.js"]
