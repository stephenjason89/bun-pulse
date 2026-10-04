# Client events

Client publishing is disabled by default. Enable it explicitly for an application that should allow authorized subscribers to send events to each other:

```ts
startBunPulse({ clientEvents: true })
```

`clientEvents` must be a boolean. The separate `requireHttpAuth` option controls HTTP publishing and does not enable client events.

After `pusher:subscription_succeeded`, official Pusher clients can call:

```ts
channel.trigger('client-position', { x: 10, y: 20 })
channel.trigger('client-note', 'hello')
```

The server accepts `client-` event names with a nonempty suffix, up to 200 characters including the prefix. It forwards them only on successfully joined `private-` or `presence-` channels. Encrypted channels are excluded. Channel names must be at most 200 characters and contain only letters, digits, `_`, `-`, `=`, `@`, `,`, `.`, or `;`.

Data may be any present JSON value, including strings, arrays, numbers, booleans, and `null`. The UTF-8 size of `JSON.stringify(data)` must not exceed 10,240 bytes. Quoting and escaping count toward this limit. Data is forwarded unchanged, and Pusher clients apply their usual decoding of JSON-encoded strings.

Each connection may publish at most ten accepted events in any rolling second, shared across its channels. The sender receives no echo. Other subscribers receive the event through Bun's native publish operation.

Presence events include the sender's authorized channel-specific `user_id` in the envelope. Official pusher-js callbacks receive it as the second argument's `metadata.user_id`. User IDs supplied in the event envelope are discarded. IDs inside application data remain untrusted application data.

Disabled publishing, invalid event or channel names, missing authorization, missing data, oversized data, and rate limits return nonfatal `pusher:error` messages. The connection and its existing subscriptions remain active. Malformed JSON or invalid outer message objects also return nonfatal errors. Unsubscribe or connection close removes permission to publish on that channel.

These events originate from other clients. Use HTTP publishing for operations that need server-side validation or persistence.

The behavior follows [Pusher's client event rules](https://pusher.com/docs/channels/using_channels/events/#triggering-client-events). The trailing `clientEvents` argument of `handleWebSocketMessage` also defaults to `false` for existing callers.
