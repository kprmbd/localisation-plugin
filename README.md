# Lifesum Localise

A Figma plugin for localising copy in designs. It reads text from the current
frame, looks up existing keys and translations in Lokalise, and uses Copy Studio
to translate new strings and generate localisation keys in Lifesum's tone of
voice.

## How it fits together

```
Figma plugin  ──►  Copy Studio MCP        translation + key generation
              └─►  Cloudflare Worker  ──►  api.lokalise.com   (CORS proxy, read-only)
```

Two things to know about the architecture:

- **Copy Studio owns the brand voice.** Translation and key generation run
  server-side, so no tone-of-voice prompt and no LLM API key exist in this repo.
- **Lokalise must go through the Worker.** `api.lokalise.com` answers CORS
  preflights for the plugin's null origin with a 404, so direct calls always
  fail with `Failed to fetch`. The Worker forwards the request and adds the CORS
  headers. Figma's `networkAccess` allowlist does not exempt the plugin from
  CORS — routing through it does not help.

## Setup on a new machine

```bash
npm install
cp config.example.json config.local.json
```

Fill in the three values in `config.local.json`:

| Field | Where it comes from |
|---|---|
| `proxyOrigin` | The deployed Cloudflare Worker's URL, e.g. `https://<name>.<subdomain>.workers.dev` |
| `proxyKey` | The `PROXY_KEY` secret set on that Worker via `wrangler secret put` |
| `copyStudioMcpUrl` | The Copy Studio MCP endpoint, ending in `/mcp` |
| `lokaliseToken` | *Optional.* Lokalise API token to pre-fill Settings |
| `copyStudioToken` | *Optional.* Copy Studio access token to pre-fill Settings |

The two token fields can stay empty, in which case the plugin asks for them in
Settings. If you fill them in, they are compiled into `dist/` — anyone you give
that build to can extract them and will be using your tokens.

Then build:

```bash
npm run build
```

This generates `dist/` and `manifest.json`. Both are git-ignored, because they
embed the values above.

## Loading the plugin in Figma

Figma → Plugins → Development → **Import plugin from manifest…** → pick the
generated `manifest.json` in this directory.

Unless they were set in `config.local.json`, the plugin needs two tokens,
pasted into its **Settings** tab on first run:

- A **Lokalise API token** (read-only is enough)
- A **Copy Studio access token**

Both are stored in `figma.clientStorage` on your machine. They are never written
to this repo and never sent anywhere except the two endpoints above, so each
device needs them entered once.

## Development

```bash
npm run dev     # esbuild watch — rebuilds dist/ on change
npx tsc --noEmit  # typecheck
```

## The Worker

`worker/` holds the Lokalise CORS proxy. It is already deployed — you only need
this if you are changing or redeploying it.

```bash
cp worker/wrangler.example.toml worker/wrangler.toml
# set ALLOWED_PROJECT_IDS to your Lokalise project IDs
cd worker
npx wrangler secret put PROXY_KEY    # must match proxyKey in config.local.json
npx wrangler deploy
```

The Worker fails closed with a 503 until both the secret and the project
allowlist are set, so an unconfigured deploy is never an open relay to Lokalise.

Access is gated twice: the `X-Proxy-Key` header keeps drive-by traffic off the
endpoint, and — because that key ships inside the plugin bundle and is therefore
extractable — the real gate is that the caller's Lokalise token must be able to
see an allowlisted project.

## What is not in this repo

Endpoints, the proxy key and the Lokalise project IDs live only in the
git-ignored `config.local.json` and `worker/wrangler.toml`. User API tokens live
only in Figma's client storage. Start from the `.example` files when setting up
a new machine.
