# Duck2 🦆

A **zero-knowledge encrypted note-sharing** tool. Write a note, encrypt it in your browser, share a code. The server never sees your plaintext.

![Vanilla JS](https://img.shields.io/badge/JavaScript-Vanilla-yellow?logo=javascript)
![Encryption](https://img.shields.io/badge/Encryption-AES--256--GCM-blue?logo=letsencrypt)
![Dependencies](https://img.shields.io/badge/Dependencies-0-brightgreen)

## How It Works

```
You type a note
    ↓
Compressed (deflate-raw)
    ↓
Encrypted with AES-256-GCM (PBKDF2, 600K iterations, your passphrase)
    ↓
Encoded in Z85 → "Duck code"
    ↓
Optionally published to pastes.dev → short code
```

Everything happens **client-side**. The paste service only ever stores ciphertext. No passphrase? The note is still compressed and encoded, but anyone with the code can read it.

## Features

- 🔒 **Client-side AES-256-GCM encryption** — keys never leave your browser
- 🗜️ **Compression** — notes are deflate-compressed before encryption
- 🔗 **Short codes** — publish to [pastes.dev](https://pastes.dev) for easy sharing (~30-day expiry)
- 📋 **Full codes** — self-contained, never expire, no server needed to decode
- 🪄 **Share links** — "Copy link" gives a `page#code` URL that opens the note straight in Decrypt
- 💪 **Passphrase strength hint** — a rough Weak → Strong guide while you type
- 🌗 **Dark / light theme** — toggle with persistence, respects system preference
- ⌨️ **Keyboard shortcuts** — `Ctrl/⌘+Enter` (run), `Ctrl/⌘+E` (encrypt), `Ctrl/⌘+D` (decrypt)
- 📱 **Responsive** — works on mobile

## Crypto Details

| Parameter | Value |
|-----------|-------|
| Cipher | AES-256-GCM |
| Key derivation | PBKDF2-SHA256, 600,000 iterations |
| Encoding | Z85 (ZeroMQ binary-to-text) |
| Compression | deflate-raw via Compression Streams API |
| Envelope | Magic bytes `D2` + version byte + encryption flag |

## Project Structure

```
├── index.html       # UI (119 lines)
├── style.css        # Styling with dark/light themes (778 lines)
├── duck.js          # Crypto engine + app logic (604 lines)
└── api/
    └── paste.mjs    # Serverless API proxy for paste services (95 lines)
```

## Running Locally

Just open `index.html` in a browser. No build step, no bundler, no framework.

For the short-code publishing feature, deploy the `api/` folder to a serverless platform (e.g., Vercel) or run a local proxy.

## API

The `api/paste.mjs` module exports ESM `GET`/`POST` functions for serverless deployment:

- **`POST /api/paste`** — Uploads a Duck code to pastes.dev → returns `{ id, url }`
- **`GET /api/paste?id=<code>`** — Fetches a paste (pastes.dev, falls back to paste.rs for legacy codes) → returns `{ id, code }`

## Tech Stack

Pure **vanilla HTML/CSS/JS** — no frameworks, no build tools, no dependencies. Uses the browser's native [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) and [Compression Streams API](https://developer.mozilla.org/en-US/docs/Web/API/Compression_Streams_API).

## License

No license specified — all rights reserved.
