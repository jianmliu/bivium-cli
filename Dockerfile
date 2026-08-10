# Sandboxed bivium CLI — run agents against Bivium without touching the host machine.
#
# The fresh-wallet flow needs NO host secrets: keys are generated inside the container and die
# with it, gas comes from the on-chain faucet via the keyless HTTP claim, and test assets are
# permissionless mints. The only capability the container needs is network egress to:
#   - the profile's RPC endpoint (default: ethereum-sepolia-rpc.publicnode.com)
#   - the Pages relayer origin (dev.bivium.pages.dev — /api/gas, /api/offers, /api/markets)
#   - api.coinbase.com (display-only spot for moneyness warnings; degrades gracefully if blocked)
#
#   docker build -t bivium-cli .
#   docker run --rm -it bivium-cli market list
#   docker run --rm -it --entrypoint bash bivium-cli        # interactive session inside the sandbox
#
# Keys never cross the container boundary unless you explicitly mount a volume for them.
FROM node:22-slim

RUN useradd --create-home --shell /bin/bash bivium
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && chown -R bivium:bivium /app

COPY --chown=bivium:bivium tsconfig.json ./
COPY --chown=bivium:bivium src ./src
COPY --chown=bivium:bivium test ./test
COPY --chown=bivium:bivium profiles ./profiles
COPY --chown=bivium:bivium bin ./bin
COPY --chown=bivium:bivium README.md ./

USER bivium
ENV BIVIUM_PROFILE=/app/profiles/sepolia-multiloan-v1.json

ENTRYPOINT ["node", "/app/bin/bivium.mjs"]
CMD ["--help"]
