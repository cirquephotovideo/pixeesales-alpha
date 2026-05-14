FROM nginx:1.27-alpine

# curl pour les healthchecks
RUN apk add --no-cache curl

# Args build-time injectés par Coolify (Environment Variables → Build Args)
ARG GEMINI_API_KEY=""
ARG GEMINI_MODEL="gemini-2.5-flash"

# Config nginx
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copier le dashboard
COPY index.html /usr/share/nginx/html/index.html

# Injecter la clé Gemini si fournie au build, sinon laisse vide (l'user la saisit)
RUN if [ -n "$GEMINI_API_KEY" ]; then \
      sed -i "s|__GEMINI_API_KEY_INJECTED__|$GEMINI_API_KEY|g" /usr/share/nginx/html/index.html && \
      sed -i "s|__GEMINI_MODEL_INJECTED__|$GEMINI_MODEL|g" /usr/share/nginx/html/index.html ; \
    else \
      sed -i "s|__GEMINI_API_KEY_INJECTED__||g" /usr/share/nginx/html/index.html && \
      sed -i "s|__GEMINI_MODEL_INJECTED__|gemini-2.5-flash|g" /usr/share/nginx/html/index.html ; \
    fi

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
