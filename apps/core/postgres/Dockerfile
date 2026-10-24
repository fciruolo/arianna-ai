# PostgreSQL of Arianna with pgvector (D-308). Built locally by docker compose
# (`pnpm db:up` builds it the first time; network only for the build).
#
# Same base as before, by digest (D-028): the official postgres:17.11-alpine.
# Staying on Alpine (musl) keeps the collations of an existing data/postgres:
# a Debian (glibc) image on the same volume would sort text differently and
# leave the indexes on text silently wrong. pgvector is compiled from its
# release tarball, checked by sha256, in a throwaway stage; the final image is
# the base plus the extension files, without compilers.
#
# To update: move PGVECTOR_VERSION and PGVECTOR_SHA256 together (and the base
# digest with the PostgreSQL version), change the image tag in compose.yaml,
# then `ALTER EXTENSION vector UPDATE` (pnpm arianna:doctor reports it).
ARG BASE=postgres:17.11-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24

FROM ${BASE} AS build

ARG PGVECTOR_VERSION=0.8.7
ARG PGVECTOR_SHA256=cac0b10c360f05b2d521200105ba3697e773d4cd3731f5a915a7e37ebe0bea85

# build-base comes from the Alpine repositories of the base, unpinned: it only
# compiles, the result is checked by the extension's own version.
# with_llvm=no: the base is built with LLVM for JIT, but the bitcode of the
# extension is optional and would need clang of the same major.
# OPTFLAGS="": no -march=native, so the image runs on any CPU of its arch.
RUN apk add --no-cache --virtual .build-deps build-base \
 && wget -qO /tmp/pgvector.tar.gz "https://github.com/pgvector/pgvector/archive/refs/tags/v${PGVECTOR_VERSION}.tar.gz" \
 && echo "${PGVECTOR_SHA256}  /tmp/pgvector.tar.gz" | sha256sum -c - \
 && mkdir /tmp/pgvector \
 && tar -xzf /tmp/pgvector.tar.gz -C /tmp/pgvector --strip-components=1 \
 && make -C /tmp/pgvector with_llvm=no OPTFLAGS="" \
 && make -C /tmp/pgvector with_llvm=no OPTFLAGS="" install DESTDIR=/out \
 && test -f "/out$(pg_config --pkglibdir)/vector.so" \
 && test -f "/out$(pg_config --sharedir)/extension/vector--${PGVECTOR_VERSION}.sql"

FROM ${BASE}
COPY --from=build /out/usr/local/ /usr/local/
