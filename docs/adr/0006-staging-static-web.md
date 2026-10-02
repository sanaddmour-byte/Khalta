# ADR 0006 — Serve the built web app from the API on staging

Status: accepted (2026-10-02, approved with the M1.3 plan defaults)

## Context

`01-domain.md §11` lists a separate static `web` service. The app authenticates with first-party session cookies (ADR 0002) and the API allows only same-origin requests (origin guard). A separate web origin would need CORS, cross-site cookie settings and a second domain before any user has seen the system.

## Options

| Option                                                   | For                                                                            | Against                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| A. API serves `apps/web/dist` (same origin)              | One service, no CORS, cookies stay first-party, one deploy, trivial smoke test | API process serves static files (fine at this scale); no CDN      |
| B. Separate static service + proxy `/api`                | Matches the domain spec; CDN possible                                          | Second service, proxy config, cookie/origin settings to get right |
| C. Separate origin with CORS and `SameSite=None` cookies | Independent deploys                                                            | Weakens the cookie and origin protections for no current benefit  |

## Decision

Option A for staging (and production until traffic justifies a CDN). The API serves the built web app and falls back to `index.html` for non-API GET routes; `/api/*`, `/health` are never shadowed. Enabled when `WEB_DIST_DIR` points at a build (the Docker image sets it).

## Risks

A bug in static serving could shadow an API route (mitigated by registering it after all API routes and refusing paths under `/api`); large static assets compete with API traffic (negligible now).

## Reversal path

Build the web app into its own service and proxy `/api` to the API; no application code depends on the choice.
