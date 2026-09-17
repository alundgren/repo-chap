FROM node:24-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus sudo git iproute2 \
    && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
