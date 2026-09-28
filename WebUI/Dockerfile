FROM python:3.11-slim

WORKDIR /app

# Runtime data and secrets are excluded via .dockerignore (audit_logs.json, .env).
COPY app.py /app/app.py
COPY static /app/static

RUN useradd --create-home --uid 10001 appuser && chown -R appuser /app
USER appuser

# Inside a container the server must listen on all interfaces; protect it with
# IAP / an authenticated ingress. Pass APIGEE_API_KEY via a secret, not the image.
ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

CMD ["python3", "app.py"]
