FROM python:3.11-slim

WORKDIR /app

COPY requirements-ingestion.txt /tmp/requirements-ingestion.txt
RUN pip install --no-cache-dir -r /tmp/requirements-ingestion.txt

COPY ingestion /app/ingestion

CMD ["python", "-m", "ingestion.aisstream_producer"]
