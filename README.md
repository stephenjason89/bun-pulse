# BunPulse

**BunPulse** is a lightweight, high-performance WebSocket server built on Bun, fully compatible with the Pusher protocol. It serves as a drop-in replacement for applications using Pusher, allowing you to point your existing apps to **BunPulse** without the need for Pusher servers or fees. With **BunPulse**, real-time communication remains seamless, and the setup process remains minimal.

## Features

- 🟢 **Pusher Protocol Compatibility**: Drop-in replacement for Pusher. Point your apps to **BunPulse**, and everything will continue working as before.
- ⚡ **Built on Bun**: Leverages Bun's high performance for WebSocket connections.
- 🔄 **Real-time Communication**: Seamless real-time messaging and notifications.
- 🔒 **Secure Connections**: HMAC-based authentication for secure WebSocket connections.
- 🛠️ **Minimal Setup**: Get started with just a few lines of code.

## Table of Contents

- [Installation](#installation)
- [Usage](#usage)
- [Configuration](#configuration)
- [Authentication](#authentication)
- [API Reference](#api-reference)
- [Contributing](#contributing)
- [External Resources](#external-resources)
- [License](#license)

## Installation

To install **BunPulse**, use your preferred package manager:

<details>
  <summary>npm</summary>

```bash
npm install bun-pulse
```
</details> <details> <summary>pnpm</summary>

```bash
pnpm install bun-pulse
```
</details> <details> <summary>bun</summary>

```bash
bun add bun-pulse
```
</details>

Ensure you have **Bun** installed on your system. If you don't have it installed, follow the [Bun installation guide](https://bun.sh/docs/install).

## Usage

Setting up **BunPulse** is quick and easy. Here's how you can start your own WebSocket server compatible with the Pusher protocol.

### Basic Example

```typescript
import { startBunPulse } from 'bun-pulse'

// Starts BunPulse on a custom port (default: 6001)
const server = startBunPulse({ port: 7000 })
```

then `bun run your-file.ts` to start the server.

### Handling Events and Forwarding Messages

> **Note**: Typically, you won’t need to manually publish events with `server.publish()` since your backend (e.g., Laravel Broadcasting) automatically handles broadcasting events to clients via **BunPulse**. However, if you want to extend functionality or handle specific events (e.g., custom WebSocket events), you can manually manage these cases using `server.publish()` or `server.on()`.

**BunPulse** automatically forwards events from your backend to all connected clients via WebSockets, using the Pusher protocol. It seamlessly handles event broadcasting, connection heartbeats, and secure HMAC-based authentication.

When your backend triggers an event (e.g., via Laravel Broadcasting), BunPulse ensures it is delivered to all clients subscribed to the relevant channel.

### Usage in Laravel Broadcasting

To integrate **BunPulse** with Laravel Broadcasting, configure the `broadcasting.php` file like this:

```php
'pusher' => [
	'driver'  => 'pusher',
	'key'     => env('PUSHER_APP_KEY'),
	'secret'  => env('PUSHER_APP_SECRET'),
	'app_id'  => env('PUSHER_APP_ID'),
	'options' => [
		'cluster'   => env('PUSHER_APP_CLUSTER'),
		'useTLS'    => true,
		'encrypted' => true,
		'host'      => env('WS_HOST', '127.0.0.1'), // bun-pulse host
		'port'      => env('WS_PORT', 6001),        // bun-pulse port
		'scheme'    => env('WS_SCHEME', 'http'),
	],
],
```

Alternatively, other methods to configure BunPulse can be found in the [Pusher documentation](https://pusher.com/docs/channels/channels_libraries/libraries/).

### Frontend: Using Pusher.js or Laravel Echo

On the frontend, you can use the `pusher-js` package, which works seamlessly with **BunPulse**, or you can use Laravel Echo if you prefer.

#### Example with Pusher.js

```javascript
import Pusher from 'pusher-js'

const pusher = new Pusher(process.env.PUSHER_APP_KEY, {
	cluster: process.env.PUSHER_APP_CLUSTER,
	wsHost: process.env.WS_HOST || '127.0.0.1',
	wsPort: process.env.WS_PORT || 6001,
	forceTLS: false,
	enabledTransports: ['ws', 'wss'],
})

const channel = pusher.subscribe('my-channel')
channel.bind('my-event', (data) => {
	console.log(data.message)
})
```

## Configuration

You can customize **BunPulse** by passing configuration options when starting the server. These options include:

- `*`: All bun websocket server options are supported, see [bun docs](https://bun.sh/docs/api/http#bun-serve) for more info.
- `port`: Specifies the port on which the WebSocket server listens (default: `6001`).
- `subscriptionVacancyUrl`: An optional URL to notify when a channel is vacated (i.e., no more subscribers).
- `heartbeatInterval`: The interval (in milliseconds) at which WebSocket heartbeat pings are sent to keep the connection alive (default: `25000`).
- `heartbeatTimeout`: The timeout (in milliseconds) after which an inactive WebSocket connection is closed (default: `60000`).

### Example with Custom Config:

```typescript
const server = startBunPulse({
	port: 7000,
	subscriptionVacancyUrl: 'https://myserver.com/api/subscriptions/webhook',
	heartbeatInterval: 20000, // Heartbeat every 20 seconds
	heartbeatTimeout: 50000 // Timeout after 50 seconds of inactivity
})
```

## Authentication

**BunPulse** uses HMAC SHA256 authentication to ensure secure WebSocket connections. When clients subscribe to a channel, they must provide a valid `auth` token, which is verified by the server to authenticate the connection.

### How Authentication Works

1. **Token Generation**:
    - On the client side, an `auth` token is generated by your backend using HMAC SHA256.
    - The token is created using the `socketId` (provided when the WebSocket connection is established) and the channel name that the client wants to subscribe to.
    - Your backend signs this data with the `PUSHER_APP_SECRET` and sends it back to the client.

2. **Token Verification**:
    - When a client attempts to subscribe to a channel, the `auth` token is sent to **BunPulse**.
    - **BunPulse** verifies the token by recalculating the HMAC using the `socketId` and channel, and comparing it with the token received from the client.
    - This ensures that only authorized clients can subscribe to the channel.

### Setting up Pusher Authentication

To set up **BunPulse** with Pusher-style authentication, configure the following environment variables:

- `PUSHER_APP_KEY`: Your Pusher app key (used for client authentication).
- `PUSHER_APP_SECRET`: Your Pusher app secret (used for HMAC SHA256 signing).

Add these variables to your `.env` file or set them in your environment. Here's an example of the `.env` configuration:

```bash
PUSHER_APP_KEY=your-app-key
PUSHER_APP_SECRET=your-app-secret
```

### Example Backend Code for Generating the `auth` Token

In **BunPulse**, HMAC SHA256 is used to securely generate an `auth` token for client authentication. This ensures that only authorized clients can subscribe to WebSocket channels. Below is an example of how you can generate the `auth` token in your backend using Bun's `CryptoHasher`.

> **Minimum requirement**: You need at least [Bun v1.1.30](https://bun.sh/blog/bun-v1.1.30#hmac-in-bun-cryptohasher) to use this feature.

```typescript
import { CryptoHasher } from 'bun'

export function generateHmacSHA256HexDigest(socketIdChannel: string, secret: string): string {
	// Initialize a new HMAC hasher with SHA256 algorithm and the provided secret
	const hmac = new CryptoHasher('sha256', secret)

	// Update the hasher with the socket ID and channel combined in the format: `${socketId}:${channel}`
	hmac.update(socketIdChannel)

	// Generate and return the HMAC digest as a hexadecimal string
	return hmac.digest('hex')
}

// Example usage:
const socketId = 'socket-id'
const channel = 'my-channel'
const authToken = generateHmacSHA256HexDigest(`${socketId}:${channel}`, process.env.PUSHER_APP_SECRET)
```

### Explanation:

- **HMAC Generation**: This function uses Bun's `CryptoHasher` to generate an HMAC SHA256 digest from the combination of `socketId` and `channel`, signed with your `PUSHER_APP_SECRET`. The result is a hexadecimal-encoded `auth` token.

- **Example Usage**: In the example, we generate an `auth` token for the socket ID `'socket-id'` and the channel `'my-channel'` using the secret stored in the environment variable `PUSHER_APP_SECRET`.

By generating the `auth` token in this manner, you ensure secure communication between your backend and WebSocket clients.

### How BunPulse Verifies the Token

When the client subscribes to a channel, **BunPulse** uses the following logic to verify the `auth` token:

```typescript
function isAuthorized(socketId: string, data: WebSocketData): boolean {
	const expectedToken = generateHmacSHA256HexDigest(
		`${socketId}:${data.channel}`,
		String(import.meta.env.PUSHER_APP_SECRET)
	)
	return data.auth === `${import.meta.env.PUSHER_APP_KEY}:${expectedToken}`
}
```

In this verification:
- The server calculates the expected token using the `socketId` and channel provided by the client, along with the `PUSHER_APP_SECRET`.
- The token sent by the client (`data.auth`) must match the calculated token for the subscription to be authorized.

### Conclusion

With this setup, **BunPulse** ensures that only authorized clients can subscribe to channels, providing secure and reliable WebSocket communication.

## API Reference

### `startBunPulse(config?: BunPulseConfig)`

Starts the BunPulse WebSocket server.

**Arguments**:
- `config` (optional): An object containing configuration options such as:
    - `port`: Specifies the port on which the WebSocket server listens (default: `6001`).
    - `subscriptionVacancyUrl`: URL to notify when a channel is vacated.
    - `heartbeatInterval`: Interval for WebSocket heartbeats.
    - `heartbeatTimeout`: Timeout period for inactive WebSocket connections.

**Returns**: The WebSocket server instance.

---

Since **BunPulse** is primarily designed to forward messages from the backend using broadcasting tools (e.g., Laravel), you generally don't need to manually publish events or listen for specific WebSocket events. If you require manual publishing or event listening, here are the methods you can use:

### `server.publish(channel: string, event: PusherEvent)`

Publishes an event to a specific channel.

**Arguments**:
- `channel`: The name of the channel to which the event is published.
- `event`: An object containing the event name and data to be published.

**Returns**: `void`

> **Note**: In most cases, this is handled by your backend through broadcasting (e.g., Laravel Broadcasting) and is not required to be manually invoked.

### `server.on(event: string, callback: (ws, data) => void)`

Listens for specific WebSocket or Pusher events (e.g., `pusher:subscribe`).

**Arguments**:
- `event`: The name of the event (e.g., subscription or connection event).
- `callback`: The function to be executed when the event is triggered.

**Returns**: `void`

> **Note**: Event listening is generally handled through your frontend (e.g., Pusher.js or Laravel Echo) and doesn’t need to be manually configured in the server.

## Contributing

We welcome contributions to **BunPulse**! If you're interested in improving the project, fixing bugs, or adding new features, we encourage you to submit a pull request. Below are some areas where contributions would be especially valuable:

### Areas for Improvement:
1. **Presence Channels**:
   - **Goal**: Implement support for presence channels, allowing clients to track and broadcast who is currently subscribed to a channel.
   - **What’s Needed**:
      - Add member tracking logic for `presence-` prefixed channels.
      - Broadcast `pusher_internal:member_added` and `pusher_internal:member_removed` events when members join/leave the channel.
      - Provide a list of current members when a client subscribes.

2. **Client-Side Events (`client-*`)**:
   - **Goal**: Enable clients to broadcast custom events (`client-*` prefixed) to other clients in the same private channel, while excluding the sender from receiving the event.
   - **What’s Needed**:
      - Implement handling of `client-*` events.
      - Ensure that the event is only broadcast to other clients, not the sender, and only works for private channels.

3. **Encrypted Channels**:
   - **Goal**: Add support for end-to-end encryption for `private-encrypted-` prefixed channels using AES-GCM.
   - **What’s Needed**:
      - Implement message encryption/decryption.
      - Manage key sharing securely between the server and clients.

4. **Enhanced Error Handling**:
   - **Goal**: Improve the error reporting and handling for various edge cases, including invalid subscriptions, connection errors, and message handling failures.
   - **What’s Needed**:
      - Define and return more detailed error messages (`pusher:error` events).
      - Add more robust error handling mechanisms for connection issues and HTTP failures.

5. **Webhook Support**:
   - **Goal**: Add support for additional webhooks, such as when a channel is occupied or vacated.
   - **What’s Needed**:
      - Implement webhook notifications when key events occur (e.g., `channel_occupied`, `channel_vacated`, etc.).

---

### How to Contribute:
1. **Fork the repository**.
2. **Create a new branch** (`git checkout -b feature/your-feature`).
3. **Make your changes** and add tests if necessary.
4. **Commit your changes** (`git commit -m 'feat: add new feature'`).
5. **Push to your branch** (`git push origin feature/your-feature`).
6. **Open a pull request**.

### Running Tests

To run tests:

```bash
npm run test
```

Please make sure your changes pass the tests before submitting a pull request.

## External Resources

To better understand how **BunPulse** works and how it mirrors the Pusher protocol, here are some helpful resources:

- [Pusher Official Documentation](https://pusher.com/docs) - Learn more about the Pusher protocol, event broadcasting, and real-time communication.
- [WebSockets Overview](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API) - A comprehensive guide to how WebSockets work, provided by MDN.
- [Bun Documentation](https://bun.sh/docs) - Learn about Bun's features, including its high-performance server capabilities.
- [HMAC SHA256 Authentication](https://en.wikipedia.org/wiki/HMAC) - Understand the HMAC-based authentication method used by **BunPulse** for secure WebSocket connections.

## License

BunPulse is dual-licensed to promote open-source use while supporting commercial options for hosted services. You may use BunPulse under the **GNU Affero General Public License (AGPL) v3.0** for open-source purposes, or you can obtain a **Commercial License** for proprietary or competitive hosted use.

### License Options

- **AGPL-3.0 License**: This software is licensed under the AGPL-3.0. If you modify and provide BunPulse as a hosted service, you must share your modified source code under the same license.

- **Commercial License**: For proprietary use or if you intend to host BunPulse as a service without sharing your modifications publicly, you may acquire a Commercial License.

**To inquire about a Commercial License**, please contact us at stephenjasonwang@gmail.com.
