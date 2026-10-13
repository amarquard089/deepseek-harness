FROM node:22-bookworm-slim

WORKDIR /dsh

ARG DSH_CLIENT_COMMIT_HASH=0000000
ENV DSH_CLIENT_COMMIT_HASH=${DSH_CLIENT_COMMIT_HASH}

RUN apt-get update \
  && apt-get install --no-install-recommends --yes \
    g++ \
    git \
    make \
    python3 \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global pnpm@11.7.0

COPY . .

RUN CI=true HUSKY=0 pnpm install --frozen-lockfile
RUN pnpm run build

# The Candidacy Web profile enables the Playwright MCP bundle.
RUN PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright \
  node /dsh/node_modules/.pnpm/@playwright+mcp@0.0.80/node_modules/@playwright/mcp/cli.js install-browser --with-deps chrome-for-testing

COPY containers/candidacy-dsh-web-entrypoint.sh /usr/local/bin/candidacy-dsh-web
RUN chmod +x /usr/local/bin/candidacy-dsh-web

ENV DSH_HOME=/root/.dsh
ENV DSH_WEB_PORT=3080

EXPOSE 3080

ENTRYPOINT ["/usr/local/bin/candidacy-dsh-web"]
