# [1.5.0](https://github.com/stephenjason89/bun-pulse/compare/v1.4.0...v1.5.0) (2024-11-07)


### Bug Fixes

* fire `channel_vacated` webhook solely for empty presence channels ([4ec5954](https://github.com/stephenjason89/bun-pulse/commit/4ec5954216c6f9f6e755d90b990f000e1ebe1283))
* update subscription logic to trigger notifyChannelVacancy for empty public and private channels ([e0e09ae](https://github.com/stephenjason89/bun-pulse/commit/e0e09ae517a30a080842c3ea0fbcdd06a7cdd1aa))


### Features

* add signature authentication to notifyChannelVacancy webhook ([d89be6d](https://github.com/stephenjason89/bun-pulse/commit/d89be6dc3987b53617c17c1969fa9cb663e72ccb))
* added Bun.serve options support to startBunPulse ([145f8f8](https://github.com/stephenjason89/bun-pulse/commit/145f8f81ce7e86c4336baba7092457dcf9dfe9c7))
* implement delay for channel vacated webhook ([7812a99](https://github.com/stephenjason89/bun-pulse/commit/7812a9932a2873b4a745324025df935d5c2e7876))
* implemented presence channel ([a6657d0](https://github.com/stephenjason89/bun-pulse/commit/a6657d0a4a42a5cfd3b1ec976c9cb87ea54a7803))
* initial implementation of WebSocket server with Pusher protocol support ([1736228](https://github.com/stephenjason89/bun-pulse/commit/173622816bfc3bf85d775ebdb90ab073c7ba64c1))
* integrate axiom logging for webSocket events ([3aafcf3](https://github.com/stephenjason89/bun-pulse/commit/3aafcf36dc68f8af273dfc40231c8b5e634e466a))
* support multiple connections per user in presence channels ([71b9678](https://github.com/stephenjason89/bun-pulse/commit/71b96785408563d27320550e41d3fee245dcbb92))
* supported public channels ([858e40d](https://github.com/stephenjason89/bun-pulse/commit/858e40d8adb7528b7200ae5e3415223c601bbf04))
* used bun CryptoHasher instead of node:crypto alternative ([0375ad5](https://github.com/stephenjason89/bun-pulse/commit/0375ad521393ee355d54d8e1e4ec5205793ff012))
* **utils:** add utilities for generating socket IDs, HMAC SHA-256 hex digests, & consola message logger ([45b1573](https://github.com/stephenjason89/bun-pulse/commit/45b157345e66bd2edc1fc64dc61f2b11b2fdd143))
