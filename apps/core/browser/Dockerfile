# Image of the agent's browser (D-095 tappa 2, D-264). Built locally by
# `pnpm browser:build`, which writes the id of the result in
# config/browser-image.lock: the core runs only that image.
# Base by digest (manifest list, linux/arm64 and linux/amd64); packages from
# snapshot.debian.org at a fixed date, so the same Dockerfile gives the same
# versions. To update Chromium: move SNAPSHOT (and the base digest), rebuild.
FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f

ARG SNAPSHOT=20261020T000000Z

# Apt reads the snapshot over http: the packages are checked against the
# Debian keyring, and the slim base has no CA certificates. Old Release files
# are expected in a snapshot, hence Check-Valid-Until: no.
RUN printf '%s\n' \
      'Types: deb' \
      "URIs: http://snapshot.debian.org/archive/debian/${SNAPSHOT}" \
      'Suites: trixie trixie-updates' \
      'Components: main' \
      'Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp' \
      'Check-Valid-Until: no' \
      '' \
      'Types: deb' \
      "URIs: http://snapshot.debian.org/archive/debian-security/${SNAPSHOT}" \
      'Suites: trixie-security' \
      'Components: main' \
      'Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp' \
      'Check-Valid-Until: no' \
      > /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      tigervnc-standalone-server \
      socat \
      fonts-liberation \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/apt /var/log/dpkg.log \
 && groupadd --gid 10001 browser \
 && useradd --uid 10001 --gid 10001 --home-dir /srv/browser --no-create-home --shell /usr/sbin/nologin browser

COPY --chmod=0555 entrypoint.sh /usr/local/bin/arianna-browser

USER 10001:10001
ENV HOME=/srv/browser
WORKDIR /srv/browser
ENTRYPOINT ["/usr/local/bin/arianna-browser"]
