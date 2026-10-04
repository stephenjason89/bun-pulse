import type { SubscriptionData, WebhookEvent, WebSocketData } from './types'
import type { WebhookDispatcher } from './webhook'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { generateHmacSHA256HexDigest } from './utils'
import { handleWebSocketMessage, handleWebSocketUpgrade, unsubscribeFromAllChannels, unsubscribeFromChannel } from './websocket'

const originalKey = process.env.PUSHER_APP_KEY
const originalSecret = process.env.PUSHER_APP_SECRET
const sockets: { data: WebSocketData }[] = []
const server = { publish: mock((_channel: string, _message: string) => {}) }

beforeEach(() => {
	process.env.PUSHER_APP_KEY = 'subscription-state-key'
	process.env.PUSHER_APP_SECRET = 'subscription-state-secret'
})

afterEach(() => {
	for (const socket of sockets.splice(0))
		unsubscribeFromAllChannels(socket as any, server as any)
	server.publish.mockClear()
	if (originalKey === undefined)
		delete process.env.PUSHER_APP_KEY
	else
		process.env.PUSHER_APP_KEY = originalKey
	if (originalSecret === undefined)
		delete process.env.PUSHER_APP_SECRET
	else
		process.env.PUSHER_APP_SECRET = originalSecret
})

function createSocket(socketId: string) {
	const socket = {
		data: { socketId, subscribedChannels: [], channel: '', auth: '' } as WebSocketData,
		send: mock((_message: string) => {}),
		publish: mock((_channel: string, _message: string) => {}),
		close: mock(() => {}),
		subscribe: mock((_channel: string) => {}),
		unsubscribe: mock((_channel: string) => {}),
	}
	sockets.push(socket)
	return socket
}

function subscribe(socket: ReturnType<typeof createSocket>, channel: string, userId?: string, webhook?: WebhookDispatcher, userInfo = { name: userId }) {
	const channelData = userId === undefined ? undefined : JSON.stringify({ user_id: userId, user_info: userInfo })
	const signedData = channel.startsWith('presence-') && channelData ? `:${channelData}` : ''
	const subscription: SubscriptionData = {
		channel,
		auth: `subscription-state-key:${generateHmacSHA256HexDigest(`${socket.data.socketId}:${channel}${signedData}`, 'subscription-state-secret')}`,
		...(channelData === undefined ? {} : { channel_data: channelData }),
	}
	handleWebSocketMessage(socket as any, JSON.stringify({ event: 'pusher:subscribe', data: subscription }), server as any, webhook)
	return subscription
}

function recorder() {
	const sent: WebhookEvent[] = []
	const pending = new Map<string, WebhookEvent>()
	const dispatcher: WebhookDispatcher = {
		send: event => sent.push(event),
		schedule: (key, event) => pending.set(key, event),
		cancel: key => pending.delete(key),
	}
	return { sent, pending, dispatcher }
}

describe('per-channel subscription state', () => {
	it('initializes an empty prototype-safe map on WebSocket upgrade', async () => {
		const upgrade = mock((_req: Request, _options: { data: WebSocketData }) => true)
		await handleWebSocketUpgrade(new Request('http://localhost/app/subscription-state-key'), { upgrade } as any)
		const data = upgrade.mock.calls[0][1].data
		expect(data.subscriptions).toEqual({})
		expect(Object.getPrototypeOf(data.subscriptions)).toBeNull()
	})

	it('keeps independent private and presence metadata and cleans only the unsubscribed channel', () => {
		const socket = createSocket('subscription-state-multiple')
		const webhook = recorder()
		const first = subscribe(socket, 'private-state-first', undefined, webhook.dispatcher)
		const second = subscribe(socket, 'private-state-second', undefined, webhook.dispatcher)
		const alice = subscribe(socket, 'presence-state-alice', 'alice', webhook.dispatcher)
		const bob = subscribe(socket, 'presence-state-bob', 'bob', webhook.dispatcher)
		expect(socket.data.subscriptions).toEqual({
			[first.channel]: { auth: first.auth },
			[second.channel]: { auth: second.auth },
			[alice.channel]: { auth: alice.auth, channel_data: alice.channel_data, user_id: 'alice' },
			[bob.channel]: { auth: bob.auth, channel_data: bob.channel_data, user_id: 'bob' },
		})
		expect(socket.data.channel).toBe(bob.channel)
		expect(socket.data.auth).toBe(bob.auth)
		expect(socket.data.channel_data).toBe(bob.channel_data)

		unsubscribeFromChannel(socket as any, alice.channel, server as any, webhook.dispatcher)
		expect(Object.keys(socket.data.subscriptions).sort()).toEqual([first.channel, second.channel, bob.channel].sort())
		expect(socket.data.subscriptions[bob.channel].user_id).toBe('bob')
		expect([...webhook.pending.values()]).toEqual([
			{ name: 'member_removed', channel: alice.channel, user_id: 'alice' },
			{ name: 'channel_vacated', channel: alice.channel },
		])

		unsubscribeFromAllChannels(socket as any, server as any, webhook.dispatcher)
		expect(socket.data.subscriptions).toEqual({})
		expect(socket.data.subscribedChannels).toEqual([])
		expect([...webhook.pending.values()]).toContainEqual({ name: 'member_removed', channel: bob.channel, user_id: 'bob' })
		// Legacy fields remain the last successful join snapshot, even after unsubscribe.
		expect(socket.data.channel).toBe(bob.channel)
	})

	it('records no rejected authorization or missing presence identity and preserves existing snapshots', () => {
		const socket = createSocket('subscription-state-rejected')
		const accepted = subscribe(socket, 'private-state-accepted')
		for (const data of [
			{ channel: 'private-state-denied', auth: 'invalid' },
			{ channel: 'presence-state-denied', auth: 'invalid', channel_data: JSON.stringify({ user_id: 'spoofed' }) },
		]) {
			handleWebSocketMessage(socket as any, JSON.stringify({ event: 'pusher:subscribe', data }), server as any)
		}
		subscribe(socket, 'presence-state-missing-id')
		expect(Object.keys(socket.data.subscriptions)).toEqual([accepted.channel])
		expect(socket.data.channel).toBe(accepted.channel)
		expect(socket.data.auth).toBe(accepted.auth)
		expect(socket.data.subscribedChannels).toEqual([accepted.channel])
		expect(socket.close).not.toHaveBeenCalled()
	})

	it('records no metadata or webhooks when the socket cannot join the channel', () => {
		const socket = createSocket('subscription-state-failed-join')
		const webhook = recorder()
		socket.subscribe.mockImplementation(() => {
			throw new Error('Socket cannot subscribe')
		})
		subscribe(socket, 'private-state-failed-join', undefined, webhook.dispatcher)
		expect(socket.data.subscriptions).toBeUndefined()
		expect(socket.data.subscribedChannels).toEqual([])
		expect(socket.data.channel).toBe('')
		expect(webhook.sent).toEqual([])
		expect(socket.send).not.toHaveBeenCalled()
	})

	it('stores prototype-named channels and presence users as ordinary keys', () => {
		const socket = createSocket('subscription-state-prototype')
		for (const channel of ['__proto__', 'constructor', 'toString'])
			subscribe(socket, channel)
		const presence = subscribe(socket, 'presence-state-prototype', '__proto__')
		expect(Object.getPrototypeOf(socket.data.subscriptions)).toBeNull()
		expect(Object.keys(socket.data.subscriptions).sort()).toEqual(['__proto__', 'constructor', 'toString', presence.channel].sort())
		expect(socket.data.subscriptions[presence.channel].user_id).toBe('__proto__')
		expect(Object.hasOwn(Object.prototype, 'auth')).toBe(false)
		unsubscribeFromAllChannels(socket as any, server as any)
		expect(Object.keys(socket.data.subscriptions)).toEqual([])
	})

	it('rejects duplicate presence joins with another identity without leaving an orphan member', () => {
		const socket = createSocket('subscription-state-duplicate')
		const webhook = recorder()
		const first = subscribe(socket, 'presence-state-duplicate', 'alice', webhook.dispatcher)
		const originalState = socket.data.subscriptions?.[first.channel]
		subscribe(socket, first.channel, 'bob', webhook.dispatcher)
		expect(JSON.parse(socket.send.mock.calls.at(-1)[0])).toEqual({
			event: 'pusher:error',
			channel: first.channel,
			data: { message: 'Already subscribed with a different user_id' },
		})
		expect(socket.data.subscriptions[first.channel]).toBe(originalState)
		expect(socket.data.channel_data).toBe(first.channel_data)
		expect(socket.subscribe).toHaveBeenCalledTimes(1)
		expect(socket.close).not.toHaveBeenCalled()
		expect(webhook.sent).toEqual([
			{ name: 'channel_occupied', channel: first.channel },
			{ name: 'member_added', channel: first.channel, user_id: 'alice' },
		])

		unsubscribeFromAllChannels(socket as any, server as any, webhook.dispatcher)
		expect([...webhook.pending.values()]).toEqual([
			{ name: 'member_removed', channel: first.channel, user_id: 'alice' },
			{ name: 'channel_vacated', channel: first.channel },
		])
		// The channel must be empty, and a later socket sees no orphaned old identity.
		const observer = createSocket('subscription-state-after-duplicate')
		subscribe(observer, first.channel, 'carol', webhook.dispatcher)
		const acknowledged = JSON.parse(observer.send.mock.calls.at(-1)[0])
		expect(JSON.parse(acknowledged.data).presence.ids).toEqual(['carol'])
	})

	it('treats a repeated presence join as the original subscription and allows identity change after unsubscribe', () => {
		const socket = createSocket('subscription-state-idempotent')
		const webhook = recorder()
		const first = subscribe(socket, 'presence-state-idempotent', 'alice', webhook.dispatcher)
		const originalState = socket.data.subscriptions?.[first.channel]
		subscribe(socket, first.channel, 'alice', webhook.dispatcher, { name: 'changed' })
		expect(socket.data.subscriptions[first.channel]).toBe(originalState)
		expect(socket.data.channel_data).toBe(first.channel_data)
		expect(socket.data.subscribedChannels).toEqual([first.channel])
		const acknowledged = JSON.parse(socket.send.mock.calls.at(-1)[0])
		expect(JSON.parse(acknowledged.data).presence.hash).toEqual({ alice: { name: 'alice' } })
		expect(socket.publish).toHaveBeenCalledTimes(1)
		expect(socket.subscribe).toHaveBeenCalledTimes(1)
		expect(webhook.sent).toHaveLength(2)

		unsubscribeFromChannel(socket as any, first.channel, server as any, webhook.dispatcher)
		const second = subscribe(socket, first.channel, 'bob', webhook.dispatcher)
		expect(socket.data.subscriptions[first.channel]).toEqual({ auth: second.auth, channel_data: second.channel_data, user_id: 'bob' })
		expect(socket.data.channel_data).toBe(second.channel_data)
	})
})
