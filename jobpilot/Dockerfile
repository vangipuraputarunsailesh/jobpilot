FROM python:3.11-slim

WORKDIR /app

# Install system deps for lxml, pdfplumber
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc libxml2-dev libxslt-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Persist uploads and logs outside the container layer
VOLUME ["/app/resumes", "/app/logs", "/app/generated"]

EXPOSE 5000

CMD ["python", "app.py"]
