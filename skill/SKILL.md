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

3. **Start the server in the background** so it keeps serving across turns:
   ```bash
   npx -y pocketspec@latest /abs/path/to/docs
   ```
   - Run it as a background task (do not block the turn on it).
   - It prints a few lines; grab the one that looks like
     `Network:  http://192.168.x.x:4321`. That IP+port is what the phone uses.
   - If the user is already running it from source, use
     `node server.js /abs/path/to/docs` instead.
   - Pass the folder as a **path argument** (e.g. `npx -y pocketspec@latest .`),
     not bare `npx pocketspec` — bare with no args serves only folders the user
     previously registered with `pocketspec add`.
   - Port busy / want a specific one? Use `PORT=8080 npx -y pocketspec@latest
     <folder>` (the `PORT` env avoids npm's noisy `--port` flag warning).

4. **Send the URL to the user in chat,** with a short "best way to view" note.
   Post the `Network:` URL prominently so they can tap it on their phone:

   > 📱 Open this on your phone (same Wi-Fi): **http://192.168.x.x:4321**
   >
   > For the best experience:
   > - **"Add to Home Screen"** — it opens fullscreen like a native app (PWA),
   >   no browser bars. Auto-matches your phone's light/dark mode.
   > - **Tap any paragraph** to comment — your note appears right under it with a
   >   marker bar on the passage.
   > - **✏️ (top)** edits the raw markdown and saves; **💬 (floating)** leaves a
   >   general comment not tied to a paragraph.
   > - The **back button works** (folder ↔ doc), and it keeps working **offline**
   >   once loaded. Rotate to landscape for wide tables or code blocks.

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

6. **Stop when done.** Kill the background server task once the review is over,
   or leave it running if the user wants to keep iterating — ask.

## Options worth knowing

- `--read-only` — serve for reading only (no edits, no comments). Good when you
  just want them to read, not annotate.
- `--password P` (or env `POCKETSPEC_PASSWORD=P`) — require a password. Prefer
  the env var so it doesn't land in shell history.
- `--port N` — starting port (default 4321; falls back to the next free one).
- `--host H` — allow an extra `Host` header (the server rejects unknown hosts to
  prevent DNS rebinding; loopback/LAN/Tailscale are allowed by default).

## Remote access (not just same Wi-Fi)

pocketspec has **no auth by default** and binds to the LAN — only serve on
trusted networks. To reach it from outside the network, do NOT port-forward or
expose it publicly. Tell the user to use [Tailscale](https://tailscale.com):
install it on laptop + phone (same account), then open the laptop's Tailscale IP
(`tailscale ip -4`, the `100.x.y.z` address) or its `*.ts.net` MagicDNS name on
the phone — works over cellular, nothing public. Add `--password` for a second
layer.

## Notes

- Zero install — `npx` fetches and runs it. Works offline on the phone once
  loaded (renderer is vendored).
- Only `.md` files and folders are listed (dotfiles ignored); images referenced
  by docs are served too.
- Rendered markdown is sanitized, and path traversal is blocked — but it's still
  a no-auth LAN server, so treat the network as the trust boundary.
