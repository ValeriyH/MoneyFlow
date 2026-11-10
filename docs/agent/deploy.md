# Deployment

## Order
1. **Server first**: Apps Script (`apps-script/Code.gs`, `auth.gs`) → Deploy → Manage deployments → New version. Without a new version the Web App keeps the old code.
2. **Client second**: one of the two builds below.

## Two Builds, One Content
Both builds produce the same static site. They are independent, so their file lists must stay identical:

| Build | Where | Output | Backend address source |
|-------|-------|--------|------------------------|
| GitHub Pages | `.github/workflows/pages.yml` (push to `master` or manual run) | `_site/` → GitHub Pages | Repository secret `APPS_SCRIPT_ENDPOINT` |
| Other static hosts | `deploy.cmd` → `tools/deploy.ps1` | `deploy/` (recreated every time, not in git) | `tools/local-endpoint.txt` or existing `env.js` |

- Shipped: `index.html`, `app.webmanifest`, `sw.js`, `robots.txt`, `assets/`. Never shipped: `apps-script/`, `tools/`, `docs/`, `AGENTS.md`, local password/endpoint files.
- A new root file for the browser must be added to both: `$rootFiles` in `deploy.ps1` and the `Assemble site folder` step in `pages.yml`.
- `assets/js/generated/env.js` (`window.__MONEYFLOW_ENV__ = { APPS_SCRIPT_ENDPOINT }`) is generated, not in git. Missing endpoint fails the build.

## Build Steps (both builds)
1. Generate `env.js`.
2. Copy the shipped files into the output folder.
3. Run `tools/build-shell-manifest.ps1 -SiteDir <output>` (`pwsh` on the GitHub runner, Windows PowerShell 5.1 locally).

## Shell Manifest (`tools/build-shell-manifest.ps1`)
- Edits only the output copy of `sw.js`; the repository copy stays the `"dev"` template (no git changes after a build).
- File list = every file in the output folder except `sw.js`, `robots.txt`, `assets/js/generated/env.example.js`. Paths must match `^[A-Za-z0-9._/-]+$`, sorted ordinally.
- Version = first 12 hex chars of SHA-256 over the `sw.js` template + each file (`\0path\0` + bytes). Same input → same version on Windows and Linux.
- Fails if either template line (`const SHELL_VERSION = "dev";`, `const SHELL_FILES = [];`) is not found exactly once — e.g. when run twice on the same folder.
- Runtime behavior of the built worker: [offline.md](offline.md).

## Hosting Constraints
- HTTPS is required (password hashing uses `crypto.subtle`); `http://localhost` counts as secure.
- `sw.js` must sit next to `index.html`, otherwise the worker scope does not cover the app.
- Deploying the raw repository (without the build) works but has no offline shell: the template worker intercepts nothing.

## Local Run
- `start.cmd` → `tools/serve.ps1` serves the repository root with the unbuilt `sw.js` (no precache, files always fresh). Use port 5501 (`-Port 5501`) to avoid the owner's server.
- To test the offline shell locally, build with `deploy.cmd` and serve the `deploy/` folder with any static server on localhost (`serve.ps1` serves only the repository root).
