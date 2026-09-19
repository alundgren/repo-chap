FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus sudo git iproute2 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV VP_HOME=/opt/vite-plus
ENV PATH="/opt/vite-plus/bin:$PATH"
RUN curl -fsSL https://viteplus.dev/install.sh -o /tmp/install-vp.sh \
    && VP_VERSION=0.3.0 bash /tmp/install-vp.sh \
    && rm /tmp/install-vp.sh
ARG NODE_VERSION
WORKDIR /opt
RUN vp env pin "$NODE_VERSION" --target node-version \
    && ln -s "$(vp node -p process.execPath)" /usr/local/bin/node
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
