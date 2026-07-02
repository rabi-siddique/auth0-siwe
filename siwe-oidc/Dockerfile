# Custom SIWE OIDC image: rebuilds ONLY the frontend with a real WalletConnect project id,
# then layers it on top of the upstream binary (no slow Rust recompile).
#
# Why: the public image (ghcr.io/spruceid/siwe_oidc) ships with PROJECT_ID="", so its login
# page initialises WalletConnect with no project id, throws, and renders blank. We rebuild
# js/ui with a real id and overwrite the served static assets.
#
# PROJECT_ID is a WalletConnect (Reown) project id from https://cloud.reown.com — a public
# client-side identifier, safe to bake into the image / commit.

FROM node:16-alpine AS node_builder
ARG PROJECT_ID
ENV PROJECT_ID=${PROJECT_ID}
RUN apk add --no-cache git
RUN git clone --depth 1 https://github.com/spruceid/siwe-oidc /siwe-oidc
WORKDIR /siwe-oidc/js/ui
RUN npm install
RUN npm run build

FROM ghcr.io/spruceid/siwe_oidc:latest
# Overwrite the empty-projectId static bundle with our freshly built one.
COPY --from=node_builder /siwe-oidc/static/ /siwe-oidc/static/
EXPOSE 8000
