FROM node:22-bookworm

ARG GODSPEED_REVISION=candidate/2.0.0-beta.24
RUN apt-get update \
    && apt-get install -y --no-install-recommends git python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && git clone --depth 1 --branch "$GODSPEED_REVISION" \
       https://github.com/MichaelZelbel/godspeed-mission-control.git /opt/godspeed \
    && printf '%s\n' "$GODSPEED_REVISION" >/opt/godspeed/.scenario-source
RUN useradd --create-home --uid 10001 scenario
USER scenario
WORKDIR /work/sample
