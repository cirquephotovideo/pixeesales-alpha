FROM nginx:1.27-alpine

# Copier la config nginx custom
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copier le dashboard
COPY index.html /usr/share/nginx/html/index.html

# Healthcheck pour Coolify
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost/ || exit 1

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
