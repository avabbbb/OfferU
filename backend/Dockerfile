# =============================================
# OfferU - Backend Dockerfile
# =============================================

FROM python:3.12-slim

WORKDIR /app

# WeasyPrint/PyMuPDF runtime dependencies
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		libcairo2 \
		libpango-1.0-0 \
		libpangocairo-1.0-0 \
		libgdk-pixbuf-2.0-0 \
		libglib2.0-0 \
		libharfbuzz0b \
		libfribidi0 \
		libffi8 \
		shared-mime-info \
		fonts-noto-cjk \
		tesseract-ocr \
		tesseract-ocr-eng \
		tesseract-ocr-chi-sim \
		curl \
	&& rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir \
	--trusted-host pypi.org \
	--trusted-host files.pythonhosted.org \
	--trusted-host pypi.tuna.tsinghua.edu.cn \
	-i https://pypi.tuna.tsinghua.edu.cn/simple/ \
	-r requirements.txt

# Install Playwright Chromium browser (needs root for apt-get system deps)
RUN python -m playwright install --with-deps chromium

# Create non-root user
RUN useradd -m -u 1000 offeru

# Pre-create and chown runtime directories so the non-root user can write to them
RUN mkdir -p /app/uploads /app/data && chown -R offeru:offeru /app

# Copy app code owned by the non-root user (avoids root-owned files that
# the app cannot write to when it creates uploads/, data/, config.json, etc.)
COPY --chown=offeru:offeru . .

EXPOSE 8766

# Never run as root; curl (installed above) backs the container healthcheck.
USER offeru
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -f http://localhost:8766/api/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8766"]
