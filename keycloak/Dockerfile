# Keycloak image for the Ymax MCP setup: bundles the consent-redirect authenticator (built from
# authenticator/) and the realm export. Two stages so we don't need a JDK/Maven on the host.
#
#   Stage 1 — build the provider JAR with Maven.
#   Stage 2 — layer the JAR + realm onto the official Keycloak image.
#
# Build + run via docker-compose.yml (which passes the DB + admin + SPI-secret env).

# ---- Stage 1: build the authenticator JAR ----
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /build
COPY authenticator/pom.xml ./pom.xml
COPY authenticator/src ./src
# Single pass: compile + package. The BuildKit cache mount persists Maven's local repo (~/.m2)
# across builds, so re-runs after a pom/src tweak don't re-download every dependency.
RUN --mount=type=cache,target=/root/.m2 mvn -q -e -B package

# ---- Stage 2: Keycloak with our provider + realm ----
FROM quay.io/keycloak/keycloak:26.7.0

# The consent-redirect authenticator provider.
COPY --from=build /build/target/keycloak-consent-redirect.jar /opt/keycloak/providers/keycloak-consent-redirect.jar

# Realm import source (read at runtime by `--import-realm`).
COPY realm-export.json /opt/keycloak/data/import/realm-export.json

# Bake the provider into an optimized build so a production `start --optimized` boots fast and does
# no build step at runtime. DB vendor is fixed here (postgres); the connection URL/credentials stay
# runtime env. Local dev (`start-dev`) ignores this optimized build and re-derives its own.
ENV KC_DB=postgres
RUN /opt/keycloak/bin/kc.sh build

# Production entrypoint. Runtime config comes from env (KC_HOSTNAME, KC_DB_URL, KC_DB_USERNAME,
# KC_DB_PASSWORD, KC_PROXY_HEADERS, KC_HTTP_ENABLED, KC_BOOTSTRAP_ADMIN_*, and the SPI secret).
# The local docker-compose overrides this CMD with `start-dev --import-realm`.
CMD ["start", "--optimized", "--import-realm"]
