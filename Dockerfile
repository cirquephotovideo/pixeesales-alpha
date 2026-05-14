FROM nginx:1.27-alpine

# Installer curl pour les healthchecks Coolify
RUN apk add --no-cache curl

# Copier la config nginx custom
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copier le dashboard
COPY index.html /usr/share/nginx/html/index.html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
