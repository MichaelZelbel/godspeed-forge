FROM node:22-bookworm

ARG GODSPEED_REVISION=candidate/2.0.0-beta.24
RUN apt-get update \
    && apt-get install -y --no-install-recommends git python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && git clone --depth 1 --branch "$GODSPEED_REVISION" \
       https://github.com/MichaelZelbel/godspeed-mission-control.git /opt/godspeed \
    && printf '%s\n' "$GODSPEED_REVISION" >/opt/godspeed/.scenario-source
# The factory and Archon at the revisions setup pins, fetched once here and served from disk afterwards, so a scenario
# never reaches github.com: git on this image reads their GitHub addresses from these folders.
COPY lib/constants.mjs /tmp/constants.mjs
RUN npm install -g bun
RUN mkdir /opt/mirrors \
    && for name in FACTORY ARCHON; do \
      url=$(node -e "import('/tmp/constants.mjs').then(m => console.log(m['${name}_SOURCE'] ?? m['${name}_REPOSITORY']))") \
      && rev=$(node -e "import('/tmp/constants.mjs').then(m => console.log(m['${name}_REVISION']))") \
      && dir=/opt/mirrors/$(echo $name | tr A-Z a-z).git \
      && git init -q --bare "$dir" \
      && git -C "$dir" fetch -q --depth 1 "$url" "$rev" \
      && git -C "$dir" update-ref refs/heads/pinned "$rev" \
      && git config --system "url.$dir.insteadOf" "$url"; \
    done
RUN ln -s /usr/bin/python3 /usr/local/bin/python
RUN useradd --create-home --uid 10001 scenario
# Archon's own tools, installed where the factory's installer looks for them (its cache), so its install needs no network.
RUN rev=$(node -e "import('/tmp/constants.mjs').then(m => console.log(m.ARCHON_REVISION))") \
    && cache=/home/scenario/.cache/factory/archon \
    && mkdir -p "$cache" \
    && git clone -q --no-hardlinks --no-checkout /opt/mirrors/archon.git "$cache/$rev" \
    && git -C "$cache/$rev" checkout -q --detach "$rev" \
    && (cd "$cache/$rev" && bun install --frozen-lockfile) \
    && chown -R scenario:scenario /home/scenario/.cache
USER scenario
WORKDIR /work/sample
