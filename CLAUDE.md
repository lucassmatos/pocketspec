# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

pocketspec serves local markdown folders over the LAN so you can read docs/specs on your phone, tap a paragraph to comment, and have an AI agent read those comments back to revise the docs. It's a single-purpose tool: zero npm dependencies, Node stdlib server, vanilla-JS SPA client.

## Commands

```bash
node server.js ~/docs              # serve a folder (same as `npx pocketspec ~/docs`)
node server.js ~/a ~/b             # serve multiple folders (ephemeral roots)
node server.js                     # serve folders registered via `add` (from config.json)
node server.js --help

node server.js add ~/docs "Name"   # register a persistent root
node server.js list                # list registered roots

node server.js ~/docs --port 8080  # starting port (falls back to next free port, 10 tries)
node server.js ~/docs --read-only  # disable all writes (edit + comments)
node server.js ~/docs --password P # HTTP Basic Auth; prefer POCKETSPEC_PASSWORD env var
```

There is no build, lint, or test setup — it's plain Node + static files. Run the server and open the printed Network URL to verify changes.

## Architecture

Two files hold essentially everything:

- **`server.js`** — the entire backend. A single `http.createServer` handler routes by `pathname`. No framework, no router lib.
- **`public/app.js`** — the entire frontend SPA. Hash-based routing, renders markdown client-side via the vendored `public/marked.min.js`.

### Roots model

A "root" is one served folder, addressed by integer index. Roots come from one of two sources, resolved per request by `currentRoots()`:

- **Ephemeral**: folder paths passed on the CLI → `RUNTIME_ROOTS` (not persisted).
- **Persistent**: `config.json` `{ roots: [{name, path}] }`, managed by the `add`/`list` subcommands. `config.json` is gitignored (it holds personal paths).

If any folder args are given they fully override config; otherwise config is used.

### API (all under `/api/`)

- `GET /api/roots` — list roots `{id, name, path}`
- `GET /api/meta` — `{ readOnly }`
- `GET /api/list?root=&path=` — folder listing (`{dirs, files}`)
- `GET /api/doc?root=&path=` — raw markdown text
- `GET /api/raw?root=&path=` — images/assets referenced by docs
- `GET/POST/DELETE /api/comments?root=&path=[&id=]` — read/add/delete comments
- `POST /api/save?root=&path=` — overwrite a `.md` file (`{content}`)

Everything else falls through to static files in `public/`, then to `index.html` (SPA fallback).

### Security invariants (do not regress these)

- **Path traversal**: every file access goes through `resolveInRoot(rootIndex, relPath)`, which resolves against the root's realpath and rejects anything not inside it — checked both before and after `realpathSync` (symlink escape). New file-serving endpoints MUST use it.
- **DNS rebinding**: `hostAllowed(req)` runs first in the handler and 403s any request whose `Host` isn't loopback/LAN/Tailscale (or an explicit `--host`/`POCKETSPEC_HOST`). Don't move it below body reads or FS access.
- **Read-only**: when `READ_ONLY`, any non-GET on `/api/comments` and `/api/save` returns 403.
- **Auth**: `checkAuth` gates *every* request (constant-time compare, username ignored). Runs right after the host check.
- **XSS**: the client renders docs with `DOMPurify.sanitize(marked.parse(md))` (`public/app.js`). Docs may be untrusted — never inject raw markdown HTML. Every response also sends `X-Content-Type-Options: nosniff`.
- The server binds `0.0.0.0` by design (LAN access) — there is no auth by default. This is intentional; the README documents the trust-the-network / Tailscale model.

### Comment anchoring

Comments live in a sidecar `file.md.comments` JSON file next to the doc (`commentsPathFor` = append `.comments`). Each comment: `{id, text, anchor, ts}` where `anchor` is `{index, snippet}` or `null` (general comment).

The client re-anchors on render (`resolveAnchor` in app.js): it matches a comment to a block first by `index`, falling back to matching the 80-char `snippet`. If the passage was edited away and neither matches, the comment becomes an **orphan** and is shown under "General comments" rather than lost. Blocks are tagged with `data-bi` (block index) at render time; the snippet is `blockSnippet` (trimmed `textContent`, first 80 chars). Keep these two definitions of snippet (client `SNIPPET_LEN`/`blockSnippet` and server-stored snippet) consistent.

### Client routing

Hash routes (`#/`, `#/0`, `#/0/sub/dir`, `#/0/sub/x.md`) drive everything, so the phone back button works. PWA-enabled via `manifest.json` + icons.

## Conventions

- Everything in the repo is English — UI, CLI, server strings, comments, commit messages. Keep it that way; no Portuguese.
- No dependencies. `marked` is vendored, not installed. Don't add an npm dependency without strong reason.
