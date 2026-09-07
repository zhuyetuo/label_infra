FROM python:3.11-slim

WORKDIR /app

# tzdata：容器按 TZ 环境变量走宿主机时区（docker-compose 里统一设）
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tzdata && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml .
RUN pip install --no-cache-dir -e .

COPY . .

EXPOSE 8283

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8283"]
