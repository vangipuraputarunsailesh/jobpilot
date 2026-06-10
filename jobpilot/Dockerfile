FROM python:3.11-slim

# IMPORTANT: this Dockerfile expects the build context to be the REPO ROOT
# (i.e. the directory containing the `jobpilot/` folder), not the `jobpilot/`
# folder itself. Build with:   docker build -f jobpilot/Dockerfile .
# Railway uses repo-root as the build context by default — see railway.toml.

WORKDIR /app

# Install system deps for lxml, pdfplumber, and WeasyPrint (pango/cairo/fonts)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc libxml2-dev libxslt-dev \
    libpango-1.0-0 libpangoft2-1.0-0 libpangocairo-1.0-0 \
    libcairo2 libgdk-pixbuf-xlib-2.0-0 libffi-dev \
    fonts-liberation fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY jobpilot/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY jobpilot/ .

# Pre-create runtime directories so they exist from the first request
RUN mkdir -p /app/logs /app/generated /app/resumes

# Run as a non-root user. Create the user, hand over runtime dirs, then drop
# privileges — reduces blast radius if the container is ever compromised.
RUN useradd --system --create-home --uid 1001 appuser \
    && chown -R appuser:appuser /app
USER appuser

# EXPOSE is the local-dev default; Railway overrides it via the PORT env var
EXPOSE 5000

CMD ["python", "app.py"]
