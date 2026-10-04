# Browser client

`bun-pulse/client` replaces `pusher-js` for the common WebSocket channel API when connecting to your BunPulse server. The server entry remains `bun-pulse`. The client module uses native `WebSocket` and `fetch`, has no runtime dependencies and contains no server code. Use your public application key in the browser. Keep the application secret on your authorization server.

The extensionless `bun-pulse/client` entry works with browser bundlers and Bun. Native Node ESM requires `bun-pulse/client.js`. The package keeps its existing deep import resolution without introducing an exports map.

```ts
import BunPulseClient from 'bun-pulse/client'

const client = new BunPulseClient('your-public-app-key', {
	wsHost: 'realtime.example.com',
	wssPort: 443,
	forceTLS: true,
	channelAuthorization: {
		endpoint: '/broadcasting/auth',
		headers: { 'X-CSRF-TOKEN': csrfToken },
	},
})

client.connection.bind('connected', () => {
	console.log(client.connection.socket_id)
})

const channel = client.subscribe('private-orders')
channel.bind('pusher:subscription_succeeded', () => console.log('Subscribed'))
channel.bind('pusher:subscription_error', error => console.error(error))
channel.bind('OrderUpdated', data => console.log(data))

// Remove a subscription or stop this client and its automatic reconnects.
client.unsubscribe('private-orders')
client.disconnect()
```

For local development, set `forceTLS: false` and `wsPort` to your server port. TLS defaults to enabled. `wsHost` is the hostname without a scheme or port; `wsPath` is an optional reverse proxy path prefix. Native browsers require a trusted TLS certificate for `wss` connections.

## Laravel Echo

Pass an instance through Echo's `client` option. This uses Echo's Pusher adapter without loading `pusher-js` at runtime.

```ts
import BunPulseClient from 'bun-pulse/client'
import Echo from 'laravel-echo'

const client = new BunPulseClient('your-public-app-key', {
	wsHost: 'realtime.example.com',
	forceTLS: true,
	authEndpoint: '/broadcasting/auth',
	auth: { headers: { 'X-CSRF-TOKEN': csrfToken } },
})
const echo = new Echo({ broadcaster: 'pusher', client })

echo.private('orders').listen('OrderUpdated', data => console.log(data))
echo.join('team')
	.here(members => console.log(members))
	.joining(member => console.log(member))
	.leaving(member => console.log(member))
```

The implementation follows the common channel calls in Laravel Echo 2.5's Pusher adapter, including `listenToAll`, `stopListening`, `socketId`, presence and whisper helpers. Echo's `signin` and encrypted channels require unsupported Pusher features. User sign-in and encrypted subscriptions throw clear unsupported-feature errors.

## Supported API

- Client: `subscribe`, `unsubscribe`, `channel`, `allChannels`, `connect`, `disconnect`, `bind`, `unbind`, `bind_global`, `unbind_global`, `unbind_all`.
- Connection: `state`, `socket_id`, `connect`, `disconnect`, `bind`, `unbind`. Events include `state_change`, `connecting`, `connected`, `unavailable`, `failed`, `disconnected`, `error`.
- Channels: `name`, `subscribed`, `subscriptionPending`, `bind`, `unbind`, `bind_global`, `unbind_global`, `unbind_all`, `trigger`.
- Presence: `members.count`, `members.members`, `members.me`, `members.get(id)`, `members.each(callback)`. Subscription success receives the members object; member events receive `{ id, info }`.

Bindings support an optional callback context. `unbind` can filter by event, callback and context; `unbind_all` also removes global bindings. Channel event callbacks receive data and, when the server supplies it, a second `{ user_id }` argument. Global callbacks receive the event name and data.

Subscriptions are retained across unexpected connection loss. The SDK clears old socket IDs and presence members, reconnects and authorizes each restricted channel against its new socket ID. Outstanding authorization responses cannot revive unsubscribed channels or authorize a replacement connection. Subscription errors leave the connection and other channels active.

## Authorization

Private and presence subscriptions need a trusted backend authorization endpoint that verifies the logged-in user's access before signing with the application secret. HTTP authorization sends a `POST` with `application/x-www-form-urlencoded` fields `socket_id` and `channel_name`. Presence responses must also include a JSON string `channel_data` with `user_id` and optional `user_info`.

The modern `channelAuthorization` options support `endpoint`, `headers`, `params` and `customHandler`. The older `authEndpoint`, `auth.headers`, `auth.params` and `authorizer` callback are also accepted. Modern settings take precedence. `socket_id` and `channel_name` always identify the current request, even when custom parameters include those names.

```ts
const client = new BunPulseClient('public-key', {
	wsHost: 'realtime.example.com',
	channelAuthorization: {
		customHandler: ({ socketId, channelName }, callback) => {
			getAuthorizationFromYourBackend(socketId, channelName)
				.then(data => callback(null, data))
				.catch(error => callback(error))
		},
	},
})
```

`fetch` uses `credentials: 'same-origin'` by default. Set `authCredentials: 'include'` when an authorization endpoint on a different origin needs cookies, and configure that endpoint's CORS and CSRF protections. Network, HTTP and malformed authorization failures emit `pusher:subscription_error` on the affected channel; HTTP errors include `status`.

## Client events and connection timing

`channel.trigger('client-typing', data)` returns `true` when the SDK sends the message. It returns `false` for public channels, inactive subscriptions, invalid event prefixes, disconnected sockets or data that cannot be serialized. The return value confirms a send, not delivery. BunPulse's server must enable `clientEvents: true` to forward these messages; older versions without client-event support do not forward them. Echo whisper uses this same path.

The SDK answers server `pusher:ping` messages and sends a ping after inactivity. Defaults are a 120-second activity timeout, capped by the server's advertised timeout, a 30-second pong timeout and a 10-second connection establishment timeout. Configure `activityTimeout`, `pongTimeout` and `connectionTimeout` in milliseconds. Missing activity after a ping replaces the socket.

Unexpected closures reconnect with exponential delays from one second to 30 seconds. Set `reconnectDelay` and `maxReconnectDelay` in milliseconds to change these limits. Explicit `disconnect` cancels retries. Close code `1008` and Pusher terminal codes `4000` through `4099` stop automatic retry and enter `failed`; call `connect` after correcting the cause.

This SDK does not implement HTTP fallback transports, encrypted channels, Pusher user authentication, cached events, stats, hosted cluster discovery, transport selection, dynamic authorization providers or every `pusher-js` option. Encrypted channel subscriptions throw a clear error. Connect directly to a configured BunPulse host.
