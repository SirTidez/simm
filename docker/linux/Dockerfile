# syntax=docker/dockerfile:1.7

ARG UBUNTU_VERSION=22.04
FROM ubuntu:${UBUNTU_VERSION}

ARG BUN_VERSION=latest
ARG NODE_VERSION=22.12.0
ARG RUST_TOOLCHAIN=stable

ENV DEBIAN_FRONTEND=noninteractive
ENV BUN_INSTALL=/root/.bun
ENV CARGO_HOME=/usr/local/cargo
ENV RUSTUP_HOME=/usr/local/rustup
ENV PATH=/root/.bun/bin:/usr/local/cargo/bin:/usr/local/node/bin:${PATH}
ENV CARGO_NET_GIT_FETCH_WITH_CLI=true

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      build-essential \
      ca-certificates \
      curl \
      file \
      git \
      libayatana-appindicator3-dev \
      libfuse2 \
      libglib2.0-dev \
      libgtk-3-dev \
      libssl-dev \
      libwebkit2gtk-4.1-dev \
      libxdo-dev \
      librsvg2-dev \
      patchelf \
      pkg-config \
      tar \
      unzip \
      wget \
      xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && mkdir -p /usr/local/node \
    && tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" -C /usr/local/node --strip-components=1 \
    && rm "node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && node --version \
    && npm --version

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain "${RUST_TOOLCHAIN}" \
    && chmod -R a+w "${CARGO_HOME}" "${RUSTUP_HOME}" \
    && rustc --version \
    && cargo --version

RUN if [ "${BUN_VERSION}" = "latest" ]; then \
      curl -fsSL https://bun.com/install | bash; \
    else \
      curl -fsSL https://bun.com/install | bash -s "bun-v${BUN_VERSION}"; \
    fi \
    && bun --version

WORKDIR /workspace

COPY docker/linux/build-linux.sh /usr/local/bin/simm-build-linux
RUN chmod +x /usr/local/bin/simm-build-linux

ENTRYPOINT ["simm-build-linux"]
CMD ["build"]
