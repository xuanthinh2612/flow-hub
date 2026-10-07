FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY flowhub/ ./flowhub/

ENV FLOWHUB_HOST=0.0.0.0 \
    FLOWHUB_PORT=8787 \
    FLOWHUB_DATA_DIR=/app/data

EXPOSE 8787

CMD ["python", "-m", "flowhub"]
