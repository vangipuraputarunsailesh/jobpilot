FROM python:3.11-slim

WORKDIR /app

# Install system deps for lxml, pdfplumber, and WeasyPrint (pango/cairo/fonts)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc libxml2-dev libxslt-dev \
    libpango-1.0-0 libpangoft2-1.0-0 libpangocairo-1.0-0 \
    libcairo2 libgdk-pixbuf-xlib-2.0-0 libffi-dev \
    fonts-liberation fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Persist uploads and logs outside the container layer
VOLUME ["/app/resumes", "/app/logs", "/app/generated"]

EXPOSE 5000

CMD ["python", "app.py"]
