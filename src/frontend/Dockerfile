# Dashboard service. Build context: this folder (src/frontend).
#
# nginx serves the built dashboard and forwards `/api` to the API service at API_UPSTREAM, so the
# browser talks to one origin. Cloud Run sets PORT.

FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx:1.28-alpine

COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

# The nginx entrypoint fills ${PORT} and ${API_UPSTREAM} into the template on start.
ENV PORT=8080 \
    API_UPSTREAM=http://backend:8000

EXPOSE 8080
