# syntax=docker/dockerfile:1.7

FROM ironsh/iron-proxy:0.50.0-rc.3@sha256:5861d7774d49b41ec86afa75156574ca5c0deaabd59bee0b2448ddbd1838881d

USER root
RUN --mount=type=cache,target=/var/cache/apk,sharing=locked \
    apk add --update-cache --cache-dir /var/cache/apk curl jq

COPY services/iron-proxy/iron-proxy.yaml /usr/local/share/iron-proxy/proxy.yaml.default
COPY --chmod=755 services/iron-proxy/entrypoint.sh /entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
