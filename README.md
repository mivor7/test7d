# Duck2 🦆

A **zero-knowledge encrypted sharing** tool for notes and images. Write a note or drop in an image, lock it in your browser, and send a short **dar.vin** link. Whoever opens the link sees the note straight away, or a passphrase box if you locked it. The servers never see your passphrase or your plaintext.

![Vanilla JS](https://img.shields.io/badge/JavaScript-Vanilla-yellow?logo=javascript)
![Encryption](https://img.shields.io/badge/Encryption-AES--256--GCM-blue?logo=letsencrypt)
![Dependencies](https://img.shields.io/badge/Dependencies-0-brightgreen)

## How It Works

```
Note ─▶ deflate ─▶ AES-256-GCM (if a passphrase is set) ─▶ test7d.vercel.app/#n~<data> ─▶ dar.vin/abc12
Image ─▶ AES-256-GCM ─▶ hidden in a lossless PNG ─▶ Imgur ─▶ test7d.vercel.app/#i~<imgur id> ─▶ dar.vin/abc12
Image without a passphrase ─▶ Imgur ─▶ i.imgur.com/<id>.png ─▶ dar.vin/abc12
```

- **Notes** live inside the link itself, after the `#`. Nothing is stored anywhere except the dar.vin redirect, so the link does not expire. A note too long for a 2048-character link is put on pastes.dev first, and the dar.vin link points at that (pastes.dev keeps it for about 30 days).
- **Locked images** are encrypted, then written into the pixels of a PNG, because Imgur only hosts real images. Imgur stores what looks like noise. After the upload, the page downloads the image again and checks it byte for byte before it gives you a link.
- **Open images** (no passphrase) go to Imgur as they are, and the dar.vin link opens the `i.imgur.com` image directly.
- **Opening a link** shows a minimal page: the note or image, or just a passphrase box if it is locked.

Under the short link, **Other ways to share** offers:

| Option | What it is |
|--------|------------|
| Full link | The same link without dar.vin |
| Imgur link | The direct `i.imgur.com` image (open images) |
| pastes.dev code | A short code for the Decrypt tab (~30-day expiry) |
| Full code | The whole note as a Duck code: works offline, never expires |

## Features

- 🔒 **Client-side AES-256-GCM encryption**: keys never leave your browser
- 🔗 **dar.vin short links**: open the note directly, or ask for the passphrase first
- 🖼️ **Image sharing through Imgur**: pick, paste or drop an image; lock it or share it openly
- 🗜️ **Compression**: notes are deflate-compressed before encryption
- 📋 **Full codes**: self-contained, never expire, no server needed to decode
- 🧭 **Decrypt tab** opens dar.vin links, share links, pastes.dev codes and full codes
- 💪 **Passphrase strength hint**: a rough Weak → Strong guide while you type
- 🌗 **Dark / light theme**: toggle with persistence, respects system preference
- ⌨️ **Keyboard shortcuts**: `Ctrl/⌘+Enter` (run), `Ctrl/⌘+E` (encrypt), `Ctrl/⌘+D` (decrypt)
- 📱 **Responsive**: works on mobile

## Setup

Deploy to Vercel (the `api/` folder becomes serverless functions) and set two environment variables:

| Variable | Where to get it | Without it |
|----------|-----------------|------------|
| `DARVIN_API_KEY` | dar.vin → Settings → API keys, scope `links:write` | Links are the full `…/#n~…` URL instead of `dar.vin/…` |
| `IMGUR_CLIENT_ID` | [api.imgur.com/oauth2/addclient](https://api.imgur.com/oauth2/addclient), "anonymous usage without user authorization" | The Image button is hidden |

The dar.vin key stays on the server. The Imgur Client-ID is sent to the browser, because Imgur uploads go straight from the browser to Imgur (that avoids Vercel's 4.5 MB request limit). That is how Imgur's anonymous API is meant to be used: a Client-ID only identifies the app.

## Crypto Details

| Parameter | Value |
|-----------|-------|
| Cipher | AES-256-GCM |
| Key derivation | PBKDF2-SHA256, 600,000 iterations |
| Encoding | Z85 (full codes), base64url (links) |
| Compression | deflate-raw via Compression Streams API (notes only) |
| Envelope | Magic bytes `D2` + version byte + flags (`1` encrypted, `2` image) |
| Image container | 8-bit RGB PNG: `uint32 length ‖ envelope ‖ padding` |

### What each service can see

| Service | Locked note / image | Open note / image |
|---------|--------------------|-------------------|
| dar.vin | Ciphertext (inside the long URL) | The note, compressed but readable; the Imgur address of an open image |
| Imgur | Random-looking pixels | The image |
| pastes.dev | Ciphertext (long notes only) | The note, compressed but readable |
| Vercel | Nothing: link data sits after the `#`, which browsers never send | Nothing |

## Link Formats

Everything after `#` on the app's URL:

| Fragment | Meaning |
|----------|---------|
| `n~<base64url>` | A note envelope, inline |
| `i~<imgur id>` | An encrypted image in a PNG at `i.imgur.com/<id>.png` |
| `<Z85 code>` | A full Duck code (older share links) |
| `<paste id>` | A pastes.dev / paste.rs code (older share links) |

`~` is in neither the Z85 nor the base64url alphabet, so the formats never collide.

## Project Structure

```
├── index.html        # Editor + link viewer
├── style.css         # Styling with dark/light themes
├── duck-core.js      # Engine: crypto, encodings, PNG container, link parsing (no DOM)
├── duck.js           # App: editor, sharing, Decrypt tab, viewer
├── api/
│   ├── link.mjs      # dar.vin: shorten (POST) and resolve (GET)
│   ├── paste.mjs     # pastes.dev: upload (POST) and fetch (GET)
│   └── config.mjs    # Which services are set up
└── tests/
    └── engine.html   # Engine tests: open in a browser
```

## API

The `api/*.mjs` modules export ESM `GET`/`POST` functions for serverless deployment:

- **`POST /api/link`** `{ url }` → `{ slug, url }`. Shortens with dar.vin. Only accepts links to this deployment (with a share fragment) or direct `i.imgur.com` images, so the key cannot be used as an open shortener.
- **`GET /api/link?slug=<slug>`** → `{ slug, url }`. Where a dar.vin link points, without following it (lets Decrypt open pasted dar.vin links).
- **`POST /api/paste`**: uploads a Duck code to pastes.dev → `{ id, url }`
- **`GET /api/paste?id=<code>`**: fetches a paste (pastes.dev, falls back to paste.rs for legacy codes) → `{ id, code }`
- **`GET /api/config`** → `{ imgurClientId, darvin }`

## Running Locally

Open `index.html` in a browser for the editor, full codes and the Decrypt tab. For dar.vin links and images, run it with the functions, e.g. `vercel dev` with the environment variables above.

Open `tests/engine.html` in a browser to run the engine tests.

## Tech Stack

Pure **vanilla HTML/CSS/JS**: no frameworks, no build tools, no dependencies. Uses the browser's native [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) and [Compression Streams API](https://developer.mozilla.org/en-US/docs/Web/API/Compression_Streams_API).

## License

No license specified. All rights reserved.
