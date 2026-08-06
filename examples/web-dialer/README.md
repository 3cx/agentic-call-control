# 3CX Web Dialer

A TypeScript browser dialer that uses a 3CX programmable DN (RoutePoint) through the Call Control API. It makes and receives calls without registering a SIP endpoint.

## Features

- Browser keypad with outbound calling
- Incoming-call screen with local ringtone, accept, reject, and a 30-second timeout
- Microphone and speaker bridge using 3CX 8 kHz, 16-bit mono PCM streams
- Mute, hang up, call timer, and recent-call history
- Credentials are sent once to the local Node process and are never written to browser storage

## 3CX setup

1. In the 3CX Admin Console, create an API Integration / Voice App.
2. Set a Client ID; it is also the programmable DN used by this app.
3. Enable Call Control API access and save the generated key.
4. Assign a DID to the application if inbound external calls are required.

The app's own DN must be a RoutePoint. Audio streaming is not available for ordinary monitored extension DNs.

## Run

From the repository root:

```bash
yarn install
yarn workspace @3cx-examples/web-dialer start
```

Open <http://localhost:8787>, enter the PBX URL, Client ID, and Key, then allow microphone access.

The server listens on localhost by default. Set `PORT` to change the port:

```bash
PORT=9000 yarn workspace @3cx-examples/web-dialer start
```

## Architecture and security

The browser sends microphone PCM over a same-origin WebSocket to the local Node gateway. The gateway owns the authenticated 3CX SDK connection and bridges PCM in both directions. Call history is stored only in the browser's `localStorage`.

This is a development sample, not a production softphone. For remote deployment, add HTTPS, user authentication, authorization, rate limiting, origin validation, secure secret storage, and an explicit session policy. The sample supports one active call per browser session.

RoutePoint calls normally arrive already connected at the PBX. The incoming-call screen therefore implements a **local virtual ringing phase**: media is withheld until the user presses Accept, but the underlying RoutePoint leg is technically already connected. This differs from the real SIP ringing/answer lifecycle of a conventional registered extension.

To keep conversational latency bounded, the browser captures approximately 20 ms at a time and both sides drop stale audio when their real-time buffers exceed a small limit. Hanging up synchronously clears microphone upload, PBX writer, and browser playback queues.
