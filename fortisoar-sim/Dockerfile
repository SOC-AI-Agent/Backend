FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SOC_SIM_HOST=0.0.0.0 \
    SOC_SIM_PORT=8090 \
    SOC_BASE_URL=http://soc-core-api:8000 \
    SOC_ALERTS_FILE=/app/alerts/lab-alerts.json

WORKDIR /app

COPY app.py ./
COPY static ./static
COPY alerts ./alerts

# Drop root: nothing in this simulator needs it at runtime.
RUN useradd --create-home --uid 10001 sim && chown -R sim:sim /app
USER sim

EXPOSE 8090

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=3).status==200 else 1)"

ENTRYPOINT ["python", "/app/app.py"]
CMD ["--web"]
