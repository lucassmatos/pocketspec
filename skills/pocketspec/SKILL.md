---
name: pocketspec
description: >-
  Use when the user wants to read or review markdown specs/docs on their phone
  while you write them, or says things like "let me review this on my phone",
  "start pocketspec", "open the specs on mobile", "I want to comment on the docs
  from my phone", or "do the phone review loop". Spins up the pocketspec server
  pointed at a docs folder, sends the phone URL to the user in chat, then runs
  the review loop: read the `<file>.md.comments` sidecars the user taps out on
  their phone and revise the docs. Also use proactively after writing a batch of
  specs the user will want to review away from the keyboard.
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Glob
---

# pocketspec — write specs, review them on your phone, revise

<!-- SKILL_VERSION: 0.4.0 — the pocketspec release this skill shipped with. Bump on every release. -->
**This skill targets pocketspec `0.4.0`.** The server prints its own version
(it always runs `@latest`, so its version is the current one). If it reports a
version newer than the one above, your installed skill is behind — see
[Staying current](#staying-current).

[pocketspec](https://www.npmjs.com/package/pocketspec) lets the user read your
markdown on their phone over the local network and tap a paragraph to comment.
Comments land in a `<file>.md.comments` JSON sidecar next to the doc — which you
read back to revise. This skill runs that whole loop.

```
you write specs  →  pocketspec serves the folder  →  user reads on phone,
taps a paragraph to comment  →  comment saved to <file>.md.comments  →
you read comments back and revise  →  repeat
```

## Checklist

1. **Find the docs folder.** If the user named one, use it. Otherwise look in
   the current project for `docs/`, `specs/`, `doc/`, `spec/` (in that order);
   if none exist, ask which folder to serve. Always resolve to an **absolute
   path**.

2. **Heads-up on first run.** This downloads the `pocketspec` package from npm
   via `npx` (~200 KB, cached after the first use; zero npm dependencies). Give
   the user a one-line heads-up and proceed unless they object.

3. **Attach to the shared instance — don't spawn your own.** Every Claude
   window shares ONE pocketspec on ONE port; you just add your folder to it. So
   multiple windows don't each end up on a different port.

   a. **Check if it's already running:**
      ```bash
      npx -y pocketspec@latest status
      ```
      Prints the running instance's URL/port, or "No shared pocketspec instance
      is running." (exit 1).

   b. **If none is running, start the shared daemon** as a background task (do
      not block the turn on it). Run it with **no folder argument** — that's the
      shared instance:
      ```bash
      npx -y pocketspec@latest
      ```
      Then re-run `status` to confirm it's up. (Starting a second one while one
      is already running just prints the existing URL and exits — it won't
      spawn a duplicate.)

   c. **Attach the folder (or a single file) you want reviewed:**
      ```bash
      npx -y pocketspec@latest attach /abs/path/to/docs "Project name"
      ```
      This registers the folder with the running instance (picked up live, no
      restart) and prints the phone URL with a **deep-link straight to it**,
      e.g. `Network:  http://192.168.x.x:4321/#/2`. Pass an absolute path and a
      short, clear name so the user can tell it apart from other windows'
      folders. Pass a single `.md` file to deep-link directly to that doc.

   d. **Version check.** `status` prints `pocketspec X.Y.Z` (the current
      ecosystem version — the server is always `@latest`). Compare it to the
      `SKILL_VERSION` this skill targets (see the top of this file). If the
      server's version is **newer**, your installed skill is stale: finish the
      task normally, then tell the user once, e.g.
      > ℹ️ Your pocketspec skill is behind (skill targets `0.4.0`, server is
      > `X.Y.Z`). Update it with `npx skills add lucassmatos/pocketspec`.

   - Running from source instead of npx? Use `node server.js status` /
     `node server.js` / `node server.js attach …` the same way.

4. **Send the URL to the user in chat,** with a short "best way to view" note.
   Use the deep-link `Network:` URL that `attach` printed so they land right on
   your folder:

   > 📱 Open this on your phone (same Wi-Fi): **http://192.168.x.x:4321/#/2**
   >
   > For the best experience:
   > - **"Add to Home Screen"** — it opens fullscreen like a native app (PWA),
   >   no browser bars. Auto-matches your phone's light/dark mode.
   > - **Tap any paragraph** to comment — your note appears right under it with a
   >   marker bar on the passage.
   > - **✏️ (top)** edits the raw markdown and saves; **💬 (floating)** leaves a
   >   general comment not tied to a paragraph.
   > - The **back button works** (folder ↔ doc). Rotate to landscape for wide
   >   tables or code blocks.

5. **Run the review loop.** When the user says they've commented (or asks you to
   check / "read my comments"):
   - Find every sidecar: `Glob` for `**/*.md.comments` under the served folder.
   - Each file is JSON: `{ "comments": [ { "text", "anchor", "ts" } ] }`.
     - `anchor.snippet` = the exact passage they tapped (first ~80 chars of the
       block). `anchor.index` = its block position. `anchor: null` = a general
       comment about the whole doc.
     - `text` = their feedback. `ts` = epoch ms.
   - Address each comment: edit the corresponding `.md`, and tell the user
     concisely what you changed per comment.
   - Comments are NOT auto-deleted when you address them. Leave them (the user
     deletes from the UI), or, if the user asks, remove resolved entries from
     the sidecar JSON.

6. **When done, detach — don't kill the shared server.** Other windows may be
   serving their own folders on it:
   ```bash
   npx -y pocketspec@latest detach /abs/path/to/docs
   ```
   Only stop the background daemon if the user explicitly wants everything torn
   down. It cleans up its own state (and drops all attached folders) on exit.

## Options worth knowing

The shared instance picks a free port automatically (4321, then the next free
one) — `status`/`attach` always report the real one, so you never guess.

`--read-only`, `--password`, and `--port` are **per-process**, so they don't
apply to the shared instance. If the user wants any of them, run a **private,
independent instance** by passing the folder as an argument (own port, not
shared, not attachable):

- `--read-only` — reading only, no edits or comments:
  `npx -y pocketspec@latest /abs/path --read-only`
- `--password P` (or env `POCKETSPEC_PASSWORD=P`) — require a password. Prefer
  the env var so it doesn't land in shell history.
- `--port N` — pin a specific starting port.
- `--host H` — allow an extra `Host` header (the server rejects unknown hosts to
  prevent DNS rebinding; loopback/LAN/Tailscale are allowed by default). This
  works on the shared instance too.

## Remote access (not just same Wi-Fi)

pocketspec has **no auth by default** and binds to the LAN — only serve on
trusted networks. To reach it from outside the network, do NOT port-forward or
expose it publicly. Tell the user to use [Tailscale](https://tailscale.com):
install it on laptop + phone (same account), then open the laptop's Tailscale IP
(`tailscale ip -4`, the `100.x.y.z` address) or its `*.ts.net` MagicDNS name on
the phone — works over cellular, nothing public. Add `--password` for a second
layer.

## Staying current

Two things update on different schedules:

- **The server** auto-updates. Every command here runs `npx pocketspec@latest`,
  so the newest published server is fetched at runtime — nothing to do.
- **This skill** does NOT auto-update. It's a static copy installed via
  `npx skills add lucassmatos/pocketspec`; nothing notifies the user when it
  changes. That's why the version check in step 3d exists: the always-latest
  server reports the current version, and you compare it to this skill's
  `SKILL_VERSION` to catch a stale skill. When it's behind, the user re-runs
  `npx skills add lucassmatos/pocketspec` to pull the latest skill.

## Notes

- Zero install — `npx` fetches and runs it. No third-party CDNs: the page and
  the markdown renderer are served entirely from the laptop (vendored), so there
  are no external requests.
- Only `.md` files and folders are listed (dotfiles ignored); images referenced
  by docs are served too.
- Rendered markdown is sanitized, and path traversal is blocked — but it's still
  a no-auth LAN server, so treat the network as the trust boundary.
