FROM python:3.12-slim

ENV TZ=America/Sao_Paulo \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends git tzdata \
 && rm -rf /var/lib/apt/lists/*

# Always the contract from main: rebuild with --no-cache to pick up a new interface version
ARG INTERFACE_SOURCE="git+https://github.com/grodrigues04/interface-personal-whats.git@main"
RUN pip install "interface-personal-whats @ ${INTERFACE_SOURCE}"

WORKDIR /app
COPY validator.py ./

USER nobody
CMD ["python", "validator.py"]
