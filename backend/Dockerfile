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
	&& rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir \
	--trusted-host pypi.org \
	--trusted-host files.pythonhosted.org \
	--trusted-host pypi.tuna.tsinghua.edu.cn \
	-i https://pypi.tuna.tsinghua.edu.cn/simple/ \
	-r requirements.txt

COPY . .

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
