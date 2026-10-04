import type { Channel } from 'pusher-js'
import type { SubscriptionData, WebSocketData } from './types'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import PusherServer from 'pusher'
import PusherClient from 'pusher-js'
import { startBunPulse } from './index'
import { generateHmacSHA256HexDigest } from './utils'
import { handleWebSocketMessage, unsubscribeFromAllChannels, unsubscribeFromChannel } from './websocket'

const originalKey = process.env.PUSHER_APP_KEY
const originalSecret = process.env.PUSHER_APP_SECRET
const sockets: { data: WebSocketData }[] = []
const server = { publish: mock((_channel: string, _message: string) => {}) }
const key = 'client-event-key'
const secret = 'client-event-secret'

beforeEach(() => {
	process.env.PUSHER_APP_KEY = key
	process.env.PUSHER_APP_SECRET = secret
})

afterEach(() => {
	mock.restore()
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

function subscribe(socket: ReturnType<typeof createSocket>, channel: string, userId?: string, validAuth = true) {
	const channelData = userId === undefined ? undefined : JSON.stringify({ user_id: userId })
	const signedData = channel.startsWith('presence-') && channelData ? `:${channelData}` : ''
	const subscription: SubscriptionData = {
		channel,
		auth: validAuth ? `${key}:${generateHmacSHA256HexDigest(`${socket.data.socketId}:${channel}${signedData}`, secret)}` : 'rejected-signature',
		...(channelData === undefined ? {} : { channel_data: channelData }),
	}
	handleWebSocketMessage(socket as any, JSON.stringify({ event: 'pusher:subscribe', data: subscription }), server as any)
	socket.publish.mockClear()
	socket.send.mockClear()
}

function trigger(socket: ReturnType<typeof createSocket>, frame: unknown, enabled = true) {
	// The extra argument must remain optional for existing direct callers.
	handleWebSocketMessage(socket as any, JSON.stringify(frame), server as any, undefined, enabled)
}

function error(socket: ReturnType<typeof createSocket>) {
	const message = JSON.parse(socket.send.mock.calls.at(-1)![0])
	expect(message.event).toBe('pusher:error')
	expect(message.data.message).toEqual(expect.any(String))
	expect(socket.close).not.toHaveBeenCalled()
	return message
}

describe('authorized client events', () => {
	it('keeps client publishing disabled for existing callers', () => {
		const socket = createSocket('client-events-default')
		subscribe(socket, 'private-client-default')
		handleWebSocketMessage(socket as any, JSON.stringify({ event: 'client-update', channel: 'private-client-default', data: {} }), server as any)
		expect(socket.publish).not.toHaveBeenCalled()
		expect(error(socket).data.message).toBe('Client events are disabled')
	})

	it('publishes accepted JSON values unchanged and uses only channel-authorized presence identity', () => {
		const socket = createSocket('client-events-accepted')
		subscribe(socket, 'private-client-accepted')
		subscribe(socket, 'presence-client-alice', 'alice')
		subscribe(socket, 'presence-client-bob', 'bob')
		const values = [{ user_id: 'untrusted', position: 1 }, 'hello', '{"encoded":true}', null, false, 42, ['value']]
		for (const data of values) {
			trigger(socket, { event: 'client-update', channel: 'private-client-accepted', data, user_id: 'spoofed' })
			const published = JSON.parse(socket.publish.mock.calls.at(-1)![1])
			expect(published).toEqual({ event: 'client-update', channel: 'private-client-accepted', data })
		}
		for (const [channel, userId] of [['presence-client-alice', 'alice'], ['presence-client-bob', 'bob']]) {
			trigger(socket, { event: 'client-presence', channel, data: {}, user_id: 'spoofed' })
			expect(JSON.parse(socket.publish.mock.calls.at(-1)![1])).toEqual({ event: 'client-presence', channel, data: {}, user_id: userId })
		}
		expect(socket.publish).toHaveBeenCalledTimes(9)
		expect(socket.send).not.toHaveBeenCalled()
	})

	it('requires matching successful subscription state and rejects public, encrypted, and invalid channels', () => {
		const socket = createSocket('client-events-membership')
		for (const channel of ['client-public', 'private-encrypted-client', 'private-client-valid', 'private-client-invalid space', `private-${'x'.repeat(201)}`])
			subscribe(socket, channel)
		for (const channel of ['client-public', 'private-encrypted-client', 'private-client-missing', '__proto__', 'private-', 'private-client-invalid space', `private-${'x'.repeat(201)}`, '', null, {}, []]) {
			trigger(socket, { event: 'client-update', channel, data: {} })
			error(socket)
		}
		delete socket.data.subscriptions['private-client-valid']
		trigger(socket, { event: 'client-update', channel: 'private-client-valid', data: {} })
		error(socket)
		// Metadata without the successful channel list cannot grant membership either.
		socket.data.subscriptions['private-client-missing'] = { auth: 'not-a-successful-join' }
		trigger(socket, { event: 'client-update', channel: 'private-client-missing', data: {} })
		error(socket)
		expect(socket.publish).not.toHaveBeenCalled()
	})

	it('rejects publishing after auth rejection, unsubscribe, and disconnect cleanup', () => {
		const socket = createSocket('client-events-lifecycle')
		subscribe(socket, 'private-client-rejected', undefined, false)
		trigger(socket, { event: 'client-update', channel: 'private-client-rejected', data: {} })
		error(socket)
		subscribe(socket, 'presence-client-left', 'alice')
		unsubscribeFromChannel(socket as any, 'presence-client-left', server as any)
		trigger(socket, { event: 'client-update', channel: 'presence-client-left', data: {} })
		error(socket)
		subscribe(socket, 'private-client-closed')
		unsubscribeFromAllChannels(socket as any, server as any)
		trigger(socket, { event: 'client-update', channel: 'private-client-closed', data: {} })
		error(socket)
		expect(socket.publish).not.toHaveBeenCalled()
	})

	it('rejects missing data, empty or oversized client names, and malformed outer frames without forwarding', () => {
		const socket = createSocket('client-events-malformed')
		subscribe(socket, 'private-client-malformed')
		for (const frame of [
			{ event: 'client-update', channel: 'private-client-malformed' },
			{ event: 'client-', channel: 'private-client-malformed', data: {} },
			{ event: `client-${'x'.repeat(194)}`, channel: 'private-client-malformed', data: {} },
			{ event: 'client-update', data: {} },
			null,
			[],
			'client-update',
		]) {
			trigger(socket, frame)
			error(socket)
		}
		handleWebSocketMessage(socket as any, '{"event":"client-update",', server as any, undefined, true)
		error(socket)
		trigger(socket, { event: 'unprefixed-update', channel: 'private-client-malformed', data: {} })
		expect(socket.publish).not.toHaveBeenCalled()
		trigger(socket, { event: `client-${'x'.repeat(193)}`, channel: 'private-client-malformed', data: {} })
		expect(socket.publish).toHaveBeenCalledTimes(1)
	})

	it('bounds serialized data at 10KB in UTF-8 including string quoting and escaping', () => {
		const socket = createSocket('client-events-size')
		subscribe(socket, 'private-client-size')
		for (const data of ['a'.repeat(10239), 'é'.repeat(5120), '\\'.repeat(5120)]) {
			trigger(socket, { event: 'client-large', channel: 'private-client-size', data })
			expect(error(socket).data.message).toBe('Client event data exceeds 10KB')
		}
		expect(socket.publish).not.toHaveBeenCalled()
		trigger(socket, { event: 'client-boundary', channel: 'private-client-size', data: 'a'.repeat(10238) })
		expect(socket.publish).toHaveBeenCalledTimes(1)
	})

	it('limits each socket to ten accepted events in any rolling second across channels', () => {
		const socket = createSocket('client-events-rate')
		const peer = createSocket('client-events-rate-peer')
		subscribe(socket, 'private-client-rate-first')
		subscribe(socket, 'private-client-rate-second')
		subscribe(peer, 'private-client-rate-first')
		const now = spyOn(Date, 'now').mockReturnValue(10000)
		for (let count = 0; count < 10; count++)
			trigger(socket, { event: 'client-rate', channel: count % 2 ? 'private-client-rate-first' : 'private-client-rate-second', data: count })
		expect(socket.publish).toHaveBeenCalledTimes(10)
		now.mockReturnValue(10999)
		trigger(socket, { event: 'client-rate', channel: 'private-client-rate-first', data: 'denied' })
		expect(error(socket).data.message).toBe('Client event rate limit exceeded')
		expect(socket.publish).toHaveBeenCalledTimes(10)
		trigger(peer, { event: 'client-rate', channel: 'private-client-rate-first', data: 'independent' })
		expect(peer.publish).toHaveBeenCalledTimes(1)
		now.mockReturnValue(11000)
		trigger(socket, { event: 'client-rate', channel: 'private-client-rate-first', data: 'next-window' })
		expect(socket.publish).toHaveBeenCalledTimes(11)
	})

	it('validates configuration before starting and does not pass its option into Bun.serve', () => {
		const serve = spyOn(Bun, 'serve').mockReturnValue({ hostname: 'localhost', port: 6001 } as any)
		for (const clientEvents of ['true', 1, null, {}, []])
			expect(() => startBunPulse({ clientEvents } as any)).toThrow('clientEvents must be a boolean')
		expect(serve).not.toHaveBeenCalled()
		startBunPulse({ clientEvents: true })
		expect(Object.hasOwn(serve.mock.calls.at(-1)![0], 'clientEvents')).toBe(false)
	})
})

interface EventSource {
	bind: (event: string, callback: (...data: any[]) => void) => unknown
	unbind: (event: string, callback: (...data: any[]) => void) => unknown
}

function nextEvent(source: EventSource, event: string): Promise<any[]> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			source.unbind(event, received)
			reject(new Error(`Timed out waiting for client event ${event}`))
		}, 2000)
		function received(...data: any[]) {
			clearTimeout(timer)
			source.unbind(event, received)
			resolve(data)
		}
		source.bind(event, received)
	})
}

async function withServer(enabled: boolean, run: (connect: (userId: string) => Promise<PusherClient>) => Promise<void>) {
	const clients: PusherClient[] = []
	const local = startBunPulse({ hostname: '127.0.0.1', port: 0, ...(enabled ? { clientEvents: true } : {}), heartbeat: { interval: 10, timeout: 2000 } })
	const sdk = new PusherServer({ appId: 'client-event-app', key, secret, host: 'localhost' })
	try {
		await run(async (userId) => {
			const client = new PusherClient(key, {
				cluster: 'mt1',
				wsHost: '127.0.0.1',
				wsPort: local.port,
				forceTLS: false,
				enabledTransports: ['ws'],
				disableStats: true,
				channelAuthorization: {
					customHandler: ({ socketId, channelName }, callback) => {
						const auth = sdk.authorizeChannel(socketId, channelName, channelName.startsWith('presence-') ? { user_id: userId } : undefined)
						callback(null, channelName === 'private-client-sdk-rejected' && userId === 'alice' ? { auth: 'rejected-signature' } : auth)
					},
				},
			})
			clients.push(client)
			await nextEvent(client.connection, 'connected')
			return client
		})
	}
	finally {
		for (const client of clients) {
			const disconnected = client.connection.state === 'disconnected' ? Promise.resolve() : nextEvent(client.connection, 'disconnected')
			client.disconnect()
			await disconnected
		}
		local.stop(true)
	}
}

async function joined(client: PusherClient, name: string): Promise<Channel> {
	const channel = client.subscribe(name)
	await nextEvent(channel, 'pusher:subscription_succeeded')
	return channel
}

it('official pusher-js triggers private and presence events with no sender echo and authenticated metadata', async () => {
	await withServer(true, async (connect) => {
		const alice = await connect('alice')
		const bob = await connect('bob')
		const alicePrivate = await joined(alice, 'private-client-sdk')
		const bobPrivate = await joined(bob, 'private-client-sdk')
		const echoes: any[] = []
		alicePrivate.bind('client-note', data => echoes.push(data))
		let received = nextEvent(bobPrivate, 'client-note')
		expect(alicePrivate.trigger('client-note', { note: 'private' })).toBe(true)
		expect((await received)[0]).toEqual({ note: 'private' })
		received = nextEvent(bobPrivate, 'client-note')
		expect(alicePrivate.trigger('client-note', 'hello')).toBe(true)
		expect((await received)[0]).toBe('hello')
		const alicePresence = await joined(alice, 'presence-client-sdk')
		const bobPresence = await joined(bob, 'presence-client-sdk')
		alicePresence.bind('client-position', data => echoes.push(data))
		received = nextEvent(bobPresence, 'client-position')
		expect(alicePresence.trigger('client-position', { user_id: 'spoofed', x: 1 })).toBe(true)
		expect(await received).toEqual([{ user_id: 'spoofed', x: 1 }, { user_id: 'alice' }])
		// Bypass trigger's frame construction to prove a spoofed envelope is discarded too.
		received = nextEvent(bobPresence, 'client-position')
		alice.connection.connection.send(JSON.stringify({ event: 'client-position', channel: 'presence-client-sdk', data: { x: 2 }, user_id: 'spoofed' }))
		expect(await received).toEqual([{ x: 2 }, { user_id: 'alice' }])
		await Bun.sleep(30)
		expect(echoes).toEqual([])
	})
}, 10000)

it('official SDK client events stay disabled by default and rejected auth cannot publish to peers', async () => {
	for (const enabled of [false, true]) {
		await withServer(enabled, async (connect) => {
			const alice = await connect('alice')
			const bob = await connect('bob')
			const channelName = enabled ? 'private-client-sdk-rejected' : 'private-client-sdk-default'
			const peer = await joined(bob, channelName)
			const deliveries: unknown[] = []
			peer.bind('client-denied', data => deliveries.push(data))
			let rejected = nextEvent(alice.connection, 'error')
			if (enabled) {
				alice.subscribe(channelName)
				expect((await rejected)[0].data.message).toBe('Unauthorized')
				rejected = nextEvent(alice.connection, 'error')
				// The peer joined successfully, but the sender's authorization failed.
				alice.send_event('client-denied', {}, channelName)
			}
			else {
				// Subscription succeeds while the server keeps publishing disabled.
				await joined(alice, channelName)
				alice.channel(channelName).trigger('client-denied', {})
			}
			expect((await rejected)[0].data.message).toBe(enabled ? 'Client event requires an authorized subscription' : 'Client events are disabled')
			await Bun.sleep(30)
			expect(deliveries).toEqual([])
			expect(alice.connection.state).toBe('connected')
		})
	}
}, 10000)
