# Contributing

Thanks for helping! The project is intentionally small and dependency-light (`node-pty` + `ws`).

## Dev setup

```bash
git clone https://github.com/willwill85/TAKT-UI-CC.git && cd TAKT-UI-CC
bash scripts/install.sh
# Run an isolated instance that doesn't touch your real data / ports:
export TAKT_HOME=/tmp/takt-dev TAKT_PORT=3190 TAKT_MCP_PORT=18890 TAKT_EDA_PORT=49790
bash scripts/start.sh
```

## Before sending a PR

```bash
npm run lint      # eslint (no-undef catches most refactoring slips)
npm test          # isolated behavioral and HTTP regression tests
npm run check     # node --check + bash -n on all scripts
```

CI runs the checks on Linux and Windows, the macOS shell smoke test, and Windows packaging with self-contained native dependency verification. `npm run test:smoke` runs the portable HTTP/auth and native PTY checks. See [Windows development](docs/WINDOWS11.md) for PowerShell setup.

## Guidelines

- No machine-specific paths, IPs, host names or device ids in code or docs — everything goes through `config.js` / env vars / `nodes.json`.
- Anything that executes commands on the user's machine must stay behind the MCP token and loopback binding.
- The UI uses `server/public/index.html` and `server/public/assets/`; keep it dependency-free (no build step). New browser modules are linted.
- i18n: UI strings are currently Chinese. A string-table refactor is the most welcome contribution — open an issue first.
