# pocketspec

**Leave your AI agent writing docs and specs — read them on your phone from anywhere, comment by tapping a paragraph, and let the agent read your comments back.**

Point your AI agent (Claude, Cursor, whatever) at a folder, let it write specs while you do something else, and follow along from your phone over your local network. Spot a vague paragraph? Tap it and comment. The comment lands in a `.comments` file next to the doc — which the agent reads back to revise. The AI doc review loop, on the go.

<!-- TODO: ~20s GIF here — phone opening the doc → tapping a paragraph + typing a comment → the agent's terminal reading the .comments back. This is the #1 marketing asset; worth doing well. -->

## Quick start

```bash
npx pocketspec ~/path/to/docs
```

Starts a server on your local network and prints the address (e.g. `http://192.168.1.x:4321`) to open on your phone. Multiple folders:

```bash
npx pocketspec ~/project-a/docs ~/project-b/specs
```

No install — `npx` fetches and runs it.

## The comment loop

- **Comment a passage:** tap any paragraph/block → a comment box opens → it shows up below the block with a bar marking the passage.
- **General comment:** the floating 💬 button.
- **Edit the doc:** the ✏️ button at the top opens the raw markdown; saving writes to the file.
- Comments live in a sidecar `file.md.comments` (JSON) next to the `.md`. Easy for an agent to read: each comment stores the anchored passage, the text, and a timestamp. If the passage is later edited, the comment isn't lost — it moves to "General comments" with a reference to the original text.

## Options

```bash
npx pocketspec ~/docs --port 8080     # starting port (tries the next free one if taken)
npx pocketspec ~/docs --read-only     # read-only: no editing, no commenting
```

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
- **Want access from outside your network?** Do NOT expose this to the open internet. Use a peer-to-peer VPN like [Tailscale](https://tailscale.com): install it on your laptop and phone, then reach it via the Tailscale IP from anywhere — with nothing publicly exposed.

## How it works

- Zero npm dependencies. Node stdlib on the server; [`marked`](https://github.com/markedjs/marked) (MIT) vendored in `public/marked.min.js` rendering in the browser, so it works even with no internet on your phone.
- Lists only folders and `.md` files (dotfiles ignored). Images referenced by docs are served via `/api/raw`.
- Hash-based navigation (`#/0/folder/doc.md`), so your phone's back button works. PWA: you can "Add to Home Screen" and it opens as an app.
- Path-traversal protection: it never serves anything outside the folders you pass.

## Run from source (dev)

```bash
node server.js ~/docs            # same as npx, from the clone
node server.js --help
```

## License

MIT. `marked` is also MIT (its license is kept in the vendored file).
