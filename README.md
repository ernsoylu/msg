# CipherP2P — Peer-to-Peer End-to-End Encrypted Chat

![GitHub repo size](https://img.shields.io/github/repo-size/ernsoylu/e2e-p2p-chat)
![GitHub last commit](https://img.shields.io/github/last-commit/ernsoylu/e2e-p2p-chat)
![GitHub](https://img.shields.io/github/license/ernsoylu/e2e-p2p-chat)
![React](https://img.shields.io/badge/React-18.3-61DAFB?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?logo=typescript)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js)
![WebRTC](https://img.shields.io/badge/WebRTC-DataChannels-0073E6)

A fully serverless-feeling chat where messages flow **directly browser-to-browser** over WebRTC DataChannels. No chat server ever sees your messages.

## Table of Contents

- [Features](#features)
- [Cryptographic Algorithms](#cryptographic-algorithms)
- [How Encryption Works](#how-encryption-works)
- [Architecture](#architecture)
- [Repository Structure](#repository-structure)
- [Prerequisites](#prerequisites)
- [Run Locally](#run-locally)
- [Deploying the Signaling Server](#deploying-the-signaling-server)
- [Rebuilding the WASM Crypto Module](#rebuilding-the-wasm-crypto-module)
- [Limitations](#limitations)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgements](#acknowledgements)

## Features

- **Peer-to-peer:** Messages travel directly between browsers over WebRTC DataChannels — never through the chat server.
- **End-to-end encrypted:** RSA-2048 key wrapping + AES-256-GCM symmetric encryption. Only the recipient can decrypt.
- **Ephemeral identities:** Each page load generates a fresh RSA-2048 key pair and a random 3–5 word blockchain-style name.
- **Signaling server:** A minimal Node.js `ws` server relays only SDP/ICE metadata and public keys — never message content.
- **No persistence:** Everything lives in RAM. Reload = new name, new keys, empty chat.

## Cryptographic Algorithms

| Layer | Algorithm | Details |
|-------|-----------|---------|
| **Key generation** | **RSA-2048** | Generated via **Rust/WASM** (`crypto-wasm` crate) for performant key generation. Each browser generates an ephemeral RSA-2048 key pair on load. |
| **Key wrapping** | **RSA-OAEP** (with SHA-256) | A random AES-256 session key is wrapped with the peer's RSA-2048 public key and sent over the DataChannel. Only the holder of the matching private key can unwrap it. |
| **Symmetric encryption** | **AES-256-GCM** | Each chat message is encrypted with a fresh random 96-bit IV using AES-256-GCM (authenticated encryption — confidentiality + integrity). |
| **Randomness** | Web Crypto `getRandomValues()` | Used for IVs and session keys. |
| **NAT traversal** | STUN | Public STUN servers (`stun.l.google.com`) help peers punch through most home NATs. |

## How Encryption Works

1. **Page load:** Browser generates an ephemeral RSA-2048 key pair via Rust/WASM. The private key never leaves the browser.
2. **Peer discovery:** Public keys are exchanged through the signaling server (only public key material, never private keys).
3. **Session key exchange:** When starting a chat, the sender generates a random AES-256 session key, wraps it with the recipient's RSA-2048 public key (RSA-OAEP), and sends the wrapped key over the WebRTC DataChannel.
4. **Message encryption:** Each message is encrypted with AES-256-GCM using the unwrapped session key. The `{ iv, ciphertext }` envelope is sent over the DataChannel.
5. **Decryption:** Only the recipient, who holds the RSA-2048 private key, can unwrap the AES session key and decrypt messages.

## Architecture

```
Browser A ───────── WebRTC DataChannel ───────── Browser B
   │                          │
   └──── signaling ───────────┘
       (only SDP/ICE metadata +
        public key exchange,
        never message content)
```

## Repository Structure

```
e2e-p2p-chat/
├── README.md
├── LICENSE
├── .gitignore
├── server/              # Minimal WebRTC signaling server (Node.js + ws)
│   ├── index.js         # presence + offer/answer/ICE relay (+ public key exchange)
│   ├── words.js         # blockchain keyword list for random names
│   ├── package.json
│   └── package-lock.json
├── client/              # React + TypeScript (Vite)
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── package.json
│   ├── package-lock.json
│   ├── src/
│   │   ├── App.tsx      # UI, presence, call control
│   │   ├── webrtc.ts    # WebRTC PeerConnection / DataChannel manager
│   │   ├── crypto.ts    # RSA-2048 + AES-256-GCM (Web Crypto API)
│   │   ├── types.ts
│   │   ├── index.css
│   │   ├── main.tsx
│   │   ├── vite-env.d.ts
│   │   └── wasm/        # Compiled Rust/WASM RSA-2048 key generator
│   │       ├── crypto_wasm.js
│   │       ├── crypto_wasm_bg.wasm
│   │       └── crypto_wasm.d.ts
│   └── crypto-wasm/     # Rust source for WASM key generation
│       ├── Cargo.toml
│       ├── Cargo.lock
│       ├── src/lib.rs
│       └── pkg/         # wasm-pack build output
```

## Prerequisites

- **Node.js** >= 18 (for the signaling server)
- **npm** or a compatible package manager
- **Rust** + **wasm-pack** (only if you want to rebuild the WASM crypto module)

## Run Locally

Terminal 1 — signaling server:

```bash
cd server
npm install
npm start            # ws://localhost:3001
```

Terminal 2 — React app:

```bash
cd client
npm install
npm run dev          # http://localhost:5173
```

Open the page in two tabs/windows. Each gets a different random 3–5 word blockchain-style name (e.g. `Satoshi Cold Wallet`) and a fresh RSA-2048 key pair. Click the other user to establish a direct WebRTC connection, then chat.

### Environment

The client reads the signaling URL from `VITE_SIGNALING_URL`. To point it at a remote server, create `client/.env`:

```
VITE_SIGNALING_URL=wss://your-signaling-server.com
```

If omitted, the client defaults to the same-origin WebSocket.

## Deploying the Signaling Server

The signaling server is a small Node.js `ws` app. Deploy it anywhere:

- **Railway:** `railway up` or connect your repo
- **Render:** free web service
- **Fly.io:** small VM
- **Koyeb:** free tier

Then set `VITE_SIGNALING_URL=wss://your-signaling-server.com` in `client/.env` and redeploy.

## Rebuilding the WASM Crypto Module

If you modify the Rust source, rebuild with:

```bash
cd client/crypto-wasm
wasm-pack build --target web --out-dir ../src/wasm --out-name crypto_wasm
```

Then copy the output files to `client/src/wasm/` and rebuild the client.

## Limitations

- **NAT traversal:** Uses public STUN servers (`stun.l.google.com`). Works for most home networks. Strict corporate/NAT environments may need a TURN server.
- **1-on-1 only:** Multi-user group chat would require a mesh of DataChannels or an SFU.
- **Ephemeral:** Everything lives in RAM. Reload = new name, new RSA keys, empty chat.
- **No message history:** Nothing is persisted — close the tab, all data is gone.
- **No authentication:** Peers are identified by their random display name and ephemeral public key. Verify out-of-band if identity matters.

## Security

### Threat Model

- The signaling server is **untrusted for message content**. It only sees SDP/ICE metadata and public keys.
- The private RSA key **never leaves the browser**.
- Messages are authenticated (AES-256-GCM), so tampering is detected.

### Caveats

- This is a demonstration/research project. It has not been formally audited.
- RSA-2048 ephemeral keys provide no forward secrecy — session compromise exposes past messages.
- Do not use for high-sensitivity communications without a professional security review.

## Contributing

Contributions are welcome! Please open an issue to discuss major changes before submitting a pull request.

1. Fork the repo
2. Create your feature branch (`git checkout -b feature/your-feature`)
3. Commit your changes (`git commit -m "Add your feature"`)
4. Push to the branch (`git push origin feature/your-feature`)
5. Open a pull request

Please keep commits focused and add/update tests and documentation where applicable.

## License

This project is licensed under the [MIT License](LICENSE).

## Acknowledgements

- [WebRTC](https://webrtc.org/) — real-time peer-to-peer communication
- [ws](https://github.com/websockets/ws) — Node.js WebSocket library
- [React](https://react.dev/) + [Vite](https://vitejs.dev/) — client UI
- [node-forge](https://github.com/digitalbazaar/forge) — cryptographic utilities
- [wasm-pack](https://rustwasm.github.io/wasm-pack/) — Rust/WASM builds

---

Built with ❤️ for private, peer-to-peer communication.