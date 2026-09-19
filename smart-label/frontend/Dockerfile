# 钉具体版本：tag 上游一换底就要重装一遍 node_modules
FROM node:22-bookworm-slim AS build
WORKDIR /app
# 国内 npm 慢：默认走 npmmirror，要换回官方在 build args 里传 NPM_REGISTRY=https://registry.npmjs.org
ARG NPM_REGISTRY=https://registry.npmmirror.com
COPY package.json ./
RUN npm config set registry "$NPM_REGISTRY" && npm install
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8284
