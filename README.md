# bun-vlessclient

A VLESS client built on Bun's native APIs.

It starts a local SOCKS5 proxy, receives requests from browsers or other clients, and forwards them to a remote server via VLESS over WebSocket.

## Features

- Built on Bun native `Bun.listen` and `WebSocket`
- Local SOCKS5 proxy
- Supports VLESS over WebSocket
- Supports TLS / SNI
- Supports custom `WS_PATH` and `Host` header
- Supports early data handling during handshake

## Directory Structure

```text
bun-vlessclient/
  bun-vlessclient.ts
  package.json
  .env.example
  README.md
```

## Environment Variables

Copy `.env.example` and modify as needed:

```env
LOCAL_PORT=1080
REMOTE_HOST=example.com
REMOTE_PORT=443
UUID=00000000-0000-4000-8000-000000000000
PACKET_ENCODING=xudp
TLS=true
TLS_SERVER_NAME=example.com
TLS_INSECURE=false
WS_PATH=/your-websocket-path
WS_HOST=example.com
```

## Getting Started

Run in the current directory:

```bash
bun run start
```

Or run directly:

```bash
bun bun-vlessclient.ts
```

## Usage

After successful startup, it listens on `LOCAL_PORT` (default `1080`).

Configure your browser or system proxy as:

```text
socks5://127.0.0.1:1080
```

## Notes

- The current implementation primarily targets TCP forwarding
- `PACKET_ENCODING=xudp` is reserved as a config option, full UDP forwarding is not yet implemented
- The remote server must support VLESS over WebSocket

## Requirements

- Bun `>= 1.0.0`
