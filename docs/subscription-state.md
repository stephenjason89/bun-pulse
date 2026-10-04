# Per-channel subscription state

Each socket stores its successful joins in `ws.data.subscriptions`, a dictionary with no prototype. Channel names such as `__proto__` and `constructor` are ordinary keys.

Each entry contains the accepted `auth` and optional raw `channel_data`. Presence entries also contain `user_id`, the identity from the authorized subscription for that channel. Failed authorization, missing presence identity, and failed socket joins do not create entries. The server's channel registry remains the source for presence membership and webhook transitions.

Unsubscribe removes only the named entry. Closing the socket removes all its subscription entries. Joining several private or presence channels preserves each channel's metadata independently.

A duplicate subscription keeps the original metadata and presence member information. The server still checks authorization and acknowledges a valid repeat. A duplicate presence subscription with a different `user_id` returns a nonfatal `pusher:error` with `Already subscribed with a different user_id`. Unsubscribe first to change identity. This prevents the same socket from leaving an orphaned presence member after close.

The exported `channel`, `auth`, and `channel_data` fields remain available for compatibility, with deprecation annotations. They are the last successful join snapshot and remain after unsubscribe. Read `subscriptions[channel]` for current channel state. `subscriptions` is optional in the TypeScript interface so existing code that constructs `WebSocketData` continues to compile. Native upgrades initialize it, and subscription handling initializes it for existing callers when their first join succeeds.
