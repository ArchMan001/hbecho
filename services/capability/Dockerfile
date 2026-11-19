# hbecho 能力服务镜像（ADR-0012）：FastAPI + OpenCV + ffmpeg（>= 7.1，HEIC 解码）。构建发生在 CI，标签 = capability-<git 短 sha>（同一个 ACR 仓库 hbecho/app）。
# 基础镜像用 Debian trixie：它自带 ffmpeg 7.1.x；bookworm 的 5.1 解不了抖音的 HEVC HEIC（ADR-0012）。构建时核对版本，不满足直接失败。
# 构建上下文就是本目录（不含 .venv / tests）。不持有任何数据库或 OSS 凭证；只在 compose 内网暴露，没有 ports。
ARG BASE=python:3.12-slim-trixie
FROM ${BASE}
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && ffmpeg -version | head -1 \
 && python3 -c "import re,subprocess,sys; v=re.search(r'version n?(\d+)\.(\d+)', subprocess.check_output(['ffmpeg','-version'], text=True)); m=tuple(map(int,v.groups())); sys.exit(0 if m>=(7,1) else 'ffmpeg 版本 %s.%s < 7.1' % m)"
WORKDIR /srv
COPY pyproject.toml ./
# 只装运行依赖（pyproject 的 dependencies，单一来源）；不把本目录当作可安装包
RUN python3 -c "import tomllib; print('\n'.join(tomllib.load(open('pyproject.toml','rb'))['project']['dependencies']))" > /tmp/requirements.txt \
 && pip install -r /tmp/requirements.txt && rm /tmp/requirements.txt
COPY capability ./capability
RUN useradd --system --uid 10001 --no-create-home capability
USER capability
ENV CAPABILITY_HOST=0.0.0.0 CAPABILITY_PORT=8080
EXPOSE 8080
CMD ["python3", "-m", "capability"]
