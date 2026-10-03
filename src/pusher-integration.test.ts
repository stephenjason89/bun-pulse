import type { Channel, Members, PresenceChannel } from 'pusher-js'
import { expect, it } from 'bun:test'
import PusherServer from 'pusher'
import PusherClient from 'pusher-js'
import { startBunPulse } from './index'

interface EventSource {
	bind: (event: string, callback: (data: any) => void) => unknown
	unbind: (event: string, callback: (data: any) => void) => unknown
}

function nextEvent<T = unknown>(source: EventSource, event: string, count = 1): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			source.unbind(event, received)
			reject(new Error(`Timed out waiting for SDK event ${event}`))
		}, 2000)
		function received(data: T) {
			if (--count > 0)
				return
			clearTimeout(timer)
			source.unbind(event, received)
			resolve(data)
		}
		source.bind(event, received)
	})
}

async function withServer(run: (sdk: PusherServer, connect: (userId: string) => Promise<PusherClient>) => Promise<void>) {
	const previous = { key: process.env.PUSHER_APP_KEY, secret: process.env.PUSHER_APP_SECRET }
	process.env.PUSHER_APP_KEY = 'sdk-local-key'
	process.env.PUSHER_APP_SECRET = 'sdk-local-secret'
	const clients: PusherClient[] = []
	const server = startBunPulse({ hostname: '127.0.0.1', port: 0, heartbeat: { interval: 50, timeout: 500, sendPing: true } })
	const sdk = new PusherServer({ appId: 'sdk-local-app', key: 'sdk-local-key', secret: 'sdk-local-secret', host: '127.0.0.1', port: String(server.port), useTLS: false, timeout: 2000 })
	try {
		await run(sdk, async (userId) => {
			// The package entry point is the official Node build; all transports stay local.
			const client = new PusherClient('sdk-local-key', {
				cluster: 'mt1',
				wsHost: '127.0.0.1',
				wsPort: server.port,
				forceTLS: false,
				enabledTransports: ['ws'],
				disableStats: true,
				channelAuthorization: {
					customHandler: ({ socketId, channelName }, callback) => {
						const auth = sdk.authorizeChannel(socketId, channelName, channelName.startsWith('presence-') ? { user_id: userId, user_info: { name: userId } } : undefined)
						callback(null, channelName === 'private-rejected' ? { auth: 'sdk-local-key:invalid-signature' } : auth)
					},
				},
			})
			clients.push(client)
			await nextEvent(client.connection, 'connected')
			expect(client.connection.socket_id).toMatch(/^\d+\.\d+$/)
			return client
		})
	}
	finally {
		try {
			for (const client of clients) {
				const disconnected = client.connection.state === 'disconnected' ? Promise.resolve() : nextEvent(client.connection, 'disconnected')
				client.disconnect()
				await disconnected
			}
		}
		finally {
			server.stop(true)
			for (const [name, value] of [['PUSHER_APP_KEY', previous.key], ['PUSHER_APP_SECRET', previous.secret]]) {
				if (value === undefined)
					delete process.env[name]
				else
					process.env[name] = value
			}
		}
	}
}

async function subscribe(client: PusherClient, name: string): Promise<Channel> {
	const channel = client.subscribe(name)
	await nextEvent(channel, 'pusher:subscription_succeeded')
	return channel
}

it('official SDKs connect, authorize, broadcast channels[] and exclude the real socket ID', async () => {
	await withServer(async (sdk, connect) => {
		const first = await connect('alice')
		const second = await connect('bob')
		expect(first.connection.socket_id).not.toBe(second.connection.socket_id)
		const publicFirst = await subscribe(first, 'sdk-public')
		const publicSecond = await subscribe(second, 'sdk-public')
		const privateFirst = await subscribe(first, 'private-sdk')
		const payload = { message: 'official SDK payload', value: 42 }
		const deliveries = [publicFirst, publicSecond, privateFirst].map(channel => nextEvent(channel, 'update'))
		expect((await sdk.trigger(['sdk-public', 'private-sdk'], 'update', payload)).status).toBe(200)
		expect(await Promise.all(deliveries)).toEqual([payload, payload, payload])

		const excluded: unknown[] = []
		publicFirst.bind('excluded', data => excluded.push(data))
		const received = nextEvent(publicSecond, 'excluded')
		expect((await sdk.trigger('sdk-public', 'excluded', payload, { socket_id: first.connection.socket_id })).status).toBe(200)
		expect(await received).toEqual(payload)
		await Bun.sleep(30) // Bound the negative receive assertion after the peer delivery.
		expect(excluded).toEqual([])

		// Twelve server pings span longer than its timeout; remaining connected proves real SDK pongs.
		await nextEvent(first.connection.connection, 'ping', 12)
		expect(first.connection.state).toBe('connected')
	})
}, 10000)

it('official presence SDK sees subscription before peer joins and no self member_added', async () => {
	await withServer(async (_sdk, connect) => {
		const first = await connect('alice')
		const second = await connect('bob')
		const firstPresence = first.subscribe('presence-sdk') as PresenceChannel
		const firstOrder: string[] = []
		firstPresence.bind('pusher:subscription_succeeded', () => firstOrder.push('subscribed'))
		firstPresence.bind('pusher:member_added', member => firstOrder.push(`added:${member.id}`))
		const members = await nextEvent<Members>(firstPresence, 'pusher:subscription_succeeded')
		expect(members.count).toBe(1)
		expect(members.me).toEqual({ id: 'alice', info: { name: 'alice' } })
		const added = nextEvent(firstPresence, 'pusher:member_added')
		const secondPresence = second.subscribe('presence-sdk') as PresenceChannel
		const secondOrder: string[] = []
		secondPresence.bind('pusher:subscription_succeeded', () => secondOrder.push('subscribed'))
		secondPresence.bind('pusher:member_added', member => secondOrder.push(`added:${member.id}`))
		const joined = await nextEvent<Members>(secondPresence, 'pusher:subscription_succeeded')
		expect(await added).toEqual({ id: 'bob', info: { name: 'bob' } })
		expect(joined.count).toBe(2)
		expect(Object.keys(joined.members).sort()).toEqual(['alice', 'bob'])
		await Bun.sleep(30)
		expect(firstOrder).toEqual(['subscribed', 'added:bob'])
		expect(secondOrder).toEqual(['subscribed'])
		const removed = nextEvent(firstPresence, 'pusher:member_removed')
		second.unsubscribe('presence-sdk')
		expect(await removed).toEqual({ id: 'bob', info: { name: 'bob' } })
		expect(firstPresence.members.count).toBe(1)
	})
}, 10000)

it('a rejected SDK auth signature preserves an active subscription and socket', async () => {
	await withServer(async (sdk, connect) => {
		const client = await connect('alice')
		const channel = await subscribe(client, 'sdk-auth-survivor')
		const socketId = client.connection.socket_id
		const rejected = nextEvent<{ data: { message: string } }>(client.connection, 'error')
		client.subscribe('private-rejected')
		expect((await rejected).data.message).toBe('Unauthorized')
		const delivered = nextEvent(channel, 'still-active')
		await sdk.trigger('sdk-auth-survivor', 'still-active', { alive: true })
		expect(await delivered).toEqual({ alive: true })
		expect(client.connection.socket_id).toBe(socketId)
		expect(client.connection.state).toBe('connected')
		expect(client.channel('private-rejected').subscribed).toBe(false)
	})
}, 10000)
