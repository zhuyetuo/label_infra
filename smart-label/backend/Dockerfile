# 基础镜像钉到具体的发行版：python:3.11-slim 这个 tag 上游换底（bookworm → trixie）时，
# 整条链的缓存全部作废，apt / pip 重装一遍要几分钟。钉住之后只有自己改了 Dockerfile 才重装。
FROM python:3.11-slim-bookworm

WORKDIR /app

# 国内机器 deb.debian.org / pypi.org 很慢：默认走清华镜像，要换回官方在 docker-compose 的
# build args 里传 APT_MIRROR=deb.debian.org / PIP_INDEX_URL=https://pypi.org/simple
ARG APT_MIRROR=mirrors.tuna.tsinghua.edu.cn
ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple

# tzdata：容器按 TZ 环境变量走宿主机时区（docker-compose 里统一设）
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s#deb.debian.org#$APT_MIRROR#g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
      sed -i "s#deb.debian.org#$APT_MIRROR#g" /etc/apt/sources.list 2>/dev/null || true; \
    fi \
    && apt-get update && apt-get install -y --no-install-recommends ffmpeg tzdata && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml .
RUN pip install --no-cache-dir -i "$PIP_INDEX_URL" -e .

COPY . .

EXPOSE 8283

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8283"]
