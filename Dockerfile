FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN groupadd --system --gid 10001 solar91 \
    && useradd --system --uid 10001 --gid solar91 --no-create-home solar91
USER 10001:10001
EXPOSE 8000
CMD ["sh", "scripts/render_start.sh"]