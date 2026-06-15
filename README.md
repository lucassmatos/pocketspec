# pocketspec

**Leave your AI agent writing docs and specs — read them on your phone from anywhere, comment by tapping a paragraph, and let the agent read your comments back.**

Point your AI agent (Claude, Cursor, whatever) at a folder, let it write specs while you do something else, and follow along from your phone over your local network. Spot a vague paragraph? Tap it and comment. The comment lands in a `.comments` file next to the doc — which the agent reads back to revise. The AI doc review loop, on the go.

It's really an **agent skill** with a tiny zero-dependency server behind it: [install the skill](#quick-start--install-the-skill) with one command and your agent drives the whole thing — starting the server, handing you the URL, reading your comments back.

<p align="center">
  <img src="https://raw.githubusercontent.com/lucassmatos/pocketspec/main/docs/demo.gif" alt="pocketspec demo: read a spec on your phone, tap a paragraph to comment, and the agent reads the comment back" width="320">
</p>

## Quick start — install the skill

The easiest way to use pocketspec is as a **skill your AI agent runs for you**. One command installs it:

```bash
npx pocketspec install-skill
```

This works across agents — it installs a native [Claude Code](https://claude.com/claude-code) skill **and** writes an `AGENTS.md` section that Codex, Cursor, Gemini, Windsurf, and others read. Then just tell your agent:

> *"let me review the specs on my phone"*

…and it starts the server pointed at your docs, hands you the phone URL, and later reads your comments back to revise. (First run fetches the package via `npx` — ~200 KB, zero dependencies.)

```bash
npx pocketspec install-skill --claude    # only the Claude Code skill
npx pocketspec install-skill --agents    # only AGENTS.md (in the current folder)
npx pocketspec install-skill --print     # just print the instructions, install nothing
```

## The comment loop

- **Comment a passage:** tap any paragraph/block → a comment box opens → it shows up below the block with a bar marking the passage.
- **General comment:** the floating 💬 button.
- **Edit the doc:** the ✏️ button at the top opens the raw markdown; saving writes to the file.
- Comments live in a sidecar `file.md.comments` (JSON) next to the `.md`. Easy for an agent to read: each comment stores the anchored passage, the text, and a timestamp. If the passage is later edited, the comment isn't lost — it moves to "General comments" with a reference to the original text.

## Run it yourself (no agent)

Prefer to drive it by hand? Point it at a folder:

```bash
npx pocketspec ~/path/to/docs
```

Starts a server on your local network and prints the address (e.g. `http://192.168.1.x:4321`) to open on your phone. Multiple folders:

```bash
npx pocketspec ~/project-a/docs ~/project-b/specs
```

No install — `npx` fetches and runs it.

## Options

```bash
npx pocketspec ~/docs --port 8080     # starting port (tries the next free one if taken)
npx pocketspec ~/docs --read-only     # read-only: no editing, no commenting
npx pocketspec ~/docs --password hunter2   # require a password (HTTP Basic Auth)
```

For the password, prefer the env var so it doesn't end up in your shell history:

```bash
POCKETSPEC_PASSWORD=hunter2 npx pocketspec ~/docs
```

> If `npm` ever warns `Unknown cli config "--port"`, it's harmless (npm is just
> noisy about forwarding flags). To sidestep it, set the port via env instead:
> `PORT=8080 npx pocketspec ~/docs`.

Persistent folders (instead of passing paths every time):

```bash
npx pocketspec add ~/docs "My project"   # register
npx pocketspec list                       # list
npx pocketspec                            # serve the registered ones
```

## Security — read this

pocketspec has **no authentication** and, by default, exposes write endpoints (edit file, comment) on your local network. That's by design: the point is reading from your phone on the same Wi-Fi.

- **Use it only on a trusted network** (your home, not a coffee-shop Wi-Fi).
- Want read-only, no write risk? Use `--read-only`.
- Want a basic gate even on your LAN? Use `--password` (see [Options](#options)).
- **Want access from outside your network?** Do NOT port-forward this or put it behind a public reverse proxy — it has no auth by default. Use a peer-to-peer VPN like [Tailscale](https://tailscale.com) instead (next section): your phone reaches your laptop directly, with nothing publicly exposed.

## Access from anywhere with Tailscale

[Tailscale](https://tailscale.com) puts your laptop and phone on the same private network (a "tailnet"), so you can read your docs from the train, the office, anywhere — without exposing anything to the public internet. It's free for personal use.

1. **Install it on your laptop** (the machine running pocketspec):
   - macOS/Windows: download from [tailscale.com/download](https://tailscale.com/download).
   - Linux: `curl -fsSL https://tailscale.com/install.sh | sh`
   - Sign in (Google/GitHub/email) — this creates your tailnet.

2. **Install the Tailscale app on your phone** and sign in with the **same account**. That's what links the two devices.

3. **Find your laptop's Tailscale address.** On the laptop:
   ```bash
   tailscale ip -4        # e.g. 100.101.102.103
   ```
   Or use the MagicDNS name (Tailscale admin console → enable MagicDNS): something like `my-laptop.tail1234.ts.net`.

4. **Start pocketspec** as usual:
   ```bash
   npx pocketspec ~/docs
   ```
   It binds to all interfaces, so the Tailscale address works automatically — no extra flags.

5. **Open it on your phone** (with Tailscale on), using the Tailscale IP and the port pocketspec printed:
   ```
   http://100.101.102.103:4321
   ```
   or `http://my-laptop.tail1234.ts.net:4321` with MagicDNS.

Tips:
- It works over cellular too — you don't need to be on the same Wi-Fi once both devices are in the tailnet.
- Add `--password` (or `POCKETSPEC_PASSWORD`) for a second layer; anyone on your tailnet can otherwise reach it.
- The laptop has to be awake and running pocketspec. If your phone can't connect, check that both devices show as "Connected" in the Tailscale app.

## How it works

- Zero npm dependencies, and no third-party CDNs: the whole page — including the markdown renderer — is served straight from your laptop. [`marked`](https://github.com/markedjs/marked) (MIT) and [`DOMPurify`](https://github.com/cure53/DOMPurify) (Apache-2.0/MPL-2.0) are vendored in `public/`, so there are no external requests and nothing phoning home.
- Lists only folders and `.md` files (dotfiles ignored). Images referenced by docs are served via `/api/raw`.
- Hash-based navigation (`#/0/folder/doc.md`), so your phone's back button works. PWA: you can "Add to Home Screen" and it opens as an app.
- **Path-traversal protection**: it never serves anything outside the folders you pass.
- **DNS-rebinding protection**: only answers requests whose `Host` is a loopback/LAN/Tailscale address (add your own with `--host`), so a malicious website can't reach your local server.
- **Rendered markdown is sanitized** (DOMPurify), so a doc from an untrusted source can't run scripts in your browser.

## Run from source (dev)

```bash
node server.js ~/docs            # same as npx, from the clone
node server.js --help
```

## License

MIT. Vendored libraries keep their own licenses in their files: `marked` (MIT) and `DOMPurify` (Apache-2.0 / MPL-2.0).
