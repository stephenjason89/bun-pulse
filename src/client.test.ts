import type { AuthorizationCallback, BunPulseChannel, ClientOptions, Members } from './client'
import { expect, it } from 'bun:test'
import PusherServer from 'pusher'
import BunPulseClient from './client'
import { startBunPulse } from './index'

interface EventSource {
	bind: (event: string, callback: (...args: any[]) => void) => unknown
	unbind: (event: string, callback: (...args: any[]) => void) => unknown
}

async function withConnectionCallbacks(run: (client: BunPulseClient, connectionCount: () => number, close: () => void) => Promise<void>) {
	let count = 0
	let socket: { close: (code?: number) => void }
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(req, server) {
			if (server.upgrade(req))
				return
			return new Response('Bad Request', { status: 400 })
		},
		websocket: {
			open(ws) {
				socket = ws
				ws.send(JSON.stringify({ event: 'pusher:connection_established', data: JSON.stringify({ socket_id: `${++count}.1` }) }))
			},
			message() {},
		},
	})
	const client = new BunPulseClient('callback-key', { wsHost: '127.0.0.1', wsPort: server.port, forceTLS: false, reconnectDelay: 5, maxReconnectDelay: 5 })
	try {
		await nextEvent(client.connection, 'connected')
		await run(client, () => count, () => socket.close(1001))
	}
	finally {
		client.disconnect()
		server.stop(true)
	}
}

it('disconnect from connecting callbacks cancels opening the socket', async () => {
	for (const event of ['connecting', 'state_change']) {
		await withConnectionCallbacks(async (client, count) => {
			client.disconnect()
			client.connection.bind(event, (change) => {
				if (event === 'connecting' || change.current === 'connecting')
					client.disconnect()
			})
			client.connect()
			await Bun.sleep(40)
			expect(client.connection.state).toBe('disconnected')
			expect(count()).toBe(1)
		})
	}
})

it('disconnect from unavailable callbacks cancels retrying the socket', async () => {
	for (const event of ['unavailable', 'state_change']) {
		await withConnectionCallbacks(async (client, count, close) => {
			client.connection.bind(event, (change) => {
				if (event === 'unavailable' || change.current === 'unavailable')
					client.disconnect()
			})
			close()
			await Bun.sleep(40)
			expect(client.connection.state).toBe('disconnected')
			expect(count()).toBe(1)
		})
	}
})

it('connect from connecting callbacks opens only one replacement socket', async () => {
	for (const event of ['connecting', 'state_change']) {
		await withConnectionCallbacks(async (client, count) => {
			client.disconnect()
			client.connection.bind(event, (change) => {
				if (event === 'connecting' || change.current === 'connecting')
					client.connect()
			})
			const connected = nextEvent(client.connection, 'connected')
			client.connect()
			await connected
			await Bun.sleep(40)
			expect(count()).toBe(2)
		})
	}
})
function nextEvent<T = unknown>(source: EventSource, event: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			source.unbind(event, received)
			reject(new Error(`Timed out waiting for ${event}`))
		}, 2000)
		function received(data: T) {
			clearTimeout(timer)
			source.unbind(event, received)
			resolve(data)
		}
		source.bind(event, received)
	})
}
async function subscribe(client: BunPulseClient, name: string): Promise<BunPulseChannel> {
	const channel = client.subscribe(name)
	await nextEvent(channel, 'pusher:subscription_succeeded')
	return channel
}
async function withServer(run: (sdk: PusherServer, connect: (user: string, options?: Partial<ClientOptions>) => Promise<BunPulseClient>, port: number, restart: () => void) => Promise<void>) {
	const previous = { key: process.env.PUSHER_APP_KEY, secret: process.env.PUSHER_APP_SECRET }
	process.env.PUSHER_APP_KEY = 'sdk-local-key'
	process.env.PUSHER_APP_SECRET = 'sdk-local-secret'
	let server = startBunPulse({ hostname: '127.0.0.1', port: 0, heartbeat: { interval: 30, timeout: 300, sendPing: true } })
	const sdk = new PusherServer({ appId: 'sdk-local-app', key: 'sdk-local-key', secret: 'sdk-local-secret', host: '127.0.0.1', port: String(server.port), useTLS: false })
	const clients: BunPulseClient[] = []
	try {
		await run(sdk, async (user, options = {}) => {
			const client = new BunPulseClient('sdk-local-key', {
				wsHost: '127.0.0.1',
				wsPort: server.port,
				forceTLS: false,
				channelAuthorization: { customHandler: ({ socketId, channelName }, callback) => {
					callback(null, sdk.authorizeChannel(socketId, channelName, channelName.startsWith('presence-') ? { user_id: user, user_info: { name: user } } : undefined))
				} },
				...options,
			})
			clients.push(client)
			await nextEvent(client.connection, 'connected')
			return client
		}, server.port!, () => {
			const port = server.port
			server.stop(true)
			server = startBunPulse({ hostname: '127.0.0.1', port, heartbeat: { interval: 30, timeout: 300, sendPing: true } })
		})
	}
	finally {
		for (const client of clients)
			client.disconnect()
		// Allow close handlers to remove global server channel membership.
		await Bun.sleep(20)
		server.stop(true)
		for (const [name, value] of [['PUSHER_APP_KEY', previous.key], ['PUSHER_APP_SECRET', previous.secret]]) {
			if (value === undefined)
				delete process.env[name]
			else
				process.env[name] = value
		}
	}
}

it('browser SDK connects, authorizes, publishes through server SDK and unsubscribes', async () => {
	await withServer(async (sdk, connect) => {
		const client = await connect('alice')
		expect(client.connection.socket_id).toMatch(/^\d+\.\d+$/)
		const publicChannel = await subscribe(client, 'browser-public')
		const privateChannel = await subscribe(client, 'private-browser')
		const payload = { text: 'browser SDK', value: 42 }
		const received = [nextEvent(publicChannel, 'update'), nextEvent(privateChannel, 'update')]
		await sdk.trigger(['browser-public', 'private-browser'], 'update', payload)
		expect(await Promise.all(received)).toEqual([payload, payload])
		const delivered: unknown[] = []
		publicChannel.bind('after-unsubscribe', data => delivered.push(data))
		client.unsubscribe('browser-public')
		await sdk.trigger('browser-public', 'after-unsubscribe', {})
		await Bun.sleep(40)
		expect(delivered).toEqual([])
		expect(publicChannel.subscribed).toBe(false)
		expect(client.channel('browser-public')).toBeUndefined()
		expect(client.allChannels()).toEqual([privateChannel])
		// Multiple real server heartbeat intervals exceed the configured server timeout.
		await Bun.sleep(350)
		expect(client.connection.state).toBe('connected')
	})
})

it('native socket reconnects and reauthorizes public, private and presence channels after a server restart', async () => {
	await withServer(async (sdk, connect, _port, restart) => {
		const client = await connect('alice', { reconnectDelay: 10, maxReconnectDelay: 20 })
		const channels = await Promise.all(['browser-native-reconnect', 'private-native-reconnect', 'presence-native-reconnect'].map(name => subscribe(client, name)))
		const previousId = client.connection.socket_id
		const reconnected = nextEvent(client.connection, 'connected')
		const resubscribed = channels.map(channel => nextEvent(channel, 'pusher:subscription_succeeded'))
		restart()
		await reconnected
		await Promise.all(resubscribed)
		expect(client.connection.socket_id).not.toBe(previousId)
		expect(channels.every(channel => channel.subscribed)).toBe(true)
		expect(channels[2].members.me).toEqual({ id: 'alice', info: { name: 'alice' } })
		const received = channels.map(channel => nextEvent(channel, 'after-restart'))
		await sdk.trigger(channels.map(channel => channel.name), 'after-restart', { reconnected: true })
		expect(await Promise.all(received)).toEqual(channels.map(() => ({ reconnected: true })))
	})
})

it('browser presence members include self, peer joins/removals and prototype-like IDs', async () => {
	await withServer(async (_sdk, connect) => {
		const alice = await connect('__proto__')
		const bob = await connect('bob')
		const channel = alice.subscribe('presence-browser')
		const members = await nextEvent<Members>(channel, 'pusher:subscription_succeeded')
		expect(members.count).toBe(1)
		expect(members.me).toEqual({ id: '__proto__', info: { name: '__proto__' } })
		const added = nextEvent(channel, 'pusher:member_added')
		await subscribe(bob, 'presence-browser')
		expect(await added).toEqual({ id: 'bob', info: { name: 'bob' } })
		expect(members.count).toBe(2)
		const visited: string[] = []
		members.each(member => visited.push(member.id))
		expect(visited.sort()).toEqual(['__proto__', 'bob'])
		const removed = nextEvent(channel, 'pusher:member_removed')
		bob.unsubscribe(channel.name)
		expect(await removed).toEqual({ id: 'bob', info: { name: 'bob' } })
		expect(members.count).toBe(1)
		expect(members.get('bob')).toBeNull()
	})
})

it('HTTP authorization sends form fields, custom headers and reports failure without losing public channels', async () => {
	await withServer(async (sdk, connect) => {
		const requests: { params: Record<string, string>, csrf: string | null }[] = []
		const authServer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
			const params = Object.fromEntries(new URLSearchParams(await request.text()))
			requests.push({ params, csrf: request.headers.get('X-CSRF-TOKEN') })
			if (params.channel_name === 'private-http-rejected')
				return new Response('Denied', { status: 403 })
			return Response.json(sdk.authorizeChannel(params.socket_id, params.channel_name))
		} })
		try {
			const client = await connect('alice', { channelAuthorization: undefined, authEndpoint: `http://127.0.0.1:${authServer.port}/auth`, auth: { headers: { 'X-CSRF-TOKEN': 'local-csrf' }, params: { tenant: 'one', socket_id: 'must-not-override' } } })
			await subscribe(client, 'private-http-browser')
			expect(requests[0]).toEqual({ params: { tenant: 'one', socket_id: client.connection.socket_id!, channel_name: 'private-http-browser' }, csrf: 'local-csrf' })
			const publicChannel = await subscribe(client, 'browser-http-survivor')
			const rejected = client.subscribe('private-http-rejected')
			expect(await nextEvent<{ status: number }>(rejected, 'pusher:subscription_error')).toMatchObject({ status: 403 })
			expect(rejected.subscribed).toBe(false)
			const received = nextEvent(publicChannel, 'still-active')
			await sdk.trigger(publicChannel.name, 'still-active', { alive: true })
			expect(await received).toEqual({ alive: true })
			expect(client.connection.state).toBe('connected')
		}
		finally { authServer.stop(true) }
	})
})

it('invalid server auth remains a channel error and preserves the connected socket', async () => {
	await withServer(async (_sdk, connect) => {
		const client = await connect('alice', { channelAuthorization: { customHandler: (_params, callback) => callback(null, { auth: 'sdk-local-key:bad-signature' }) } })
		const id = client.connection.socket_id
		const channel = client.subscribe('private-browser-rejected')
		expect(await nextEvent(channel, 'pusher:subscription_error')).toEqual({ message: 'Unauthorized' })
		expect(channel.subscribed).toBe(false)
		expect(client.connection.socket_id).toBe(id)
		expect(client.connection.state).toBe('connected')
	})
})

// Deterministic transport faults use the same browser WebSocket callbacks as native sockets.
class FakeWebSocket {
	static instances: FakeWebSocket[] = []
	readyState = 1
	onmessage?: (event: { data: string }) => void
	onerror?: (event: unknown) => void
	onclose?: (event: { code: number }) => void
	sent: any[] = []
	constructor(public url: string) { FakeWebSocket.instances.push(this) }
	send(data: string) { this.sent.push(JSON.parse(data)) }
	close() { this.readyState = 3 }
	message(event: string, data: unknown = {}, channel?: string, user_id?: string) {
		this.onmessage?.({ data: JSON.stringify({ event, data: JSON.stringify(data), channel, user_id }) })
	}

	establish(id = '1.2') { this.message('pusher:connection_established', { socket_id: id, activity_timeout: 120 }) }
	fail(code = 1006) {
		this.readyState = 3
		this.onclose?.({ code })
	}
}
async function withFake(run: (client: BunPulseClient, socket: FakeWebSocket) => Promise<void> | void, options: Partial<ClientOptions> = {}) {
	const original = globalThis.WebSocket
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
	FakeWebSocket.instances = []
	const client = new BunPulseClient('browser-key', { wsHost: 'localhost', forceTLS: false, reconnectDelay: 5, maxReconnectDelay: 10, ...options })
	const socket = FakeWebSocket.instances[0]
	try {
		await run(client, socket)
	}
	finally {
		client.disconnect()
		globalThis.WebSocket = original
	}
}

it('cancelled authorization cannot subscribe after unsubscribe or reconnect', async () => {
	const pending: AuthorizationCallback[] = []
	await withFake(async (client, socket) => {
		socket.establish()
		const first = client.subscribe('private-race')
		client.unsubscribe(first.name)
		pending[0](null, { auth: 'old-auth' })
		await Bun.sleep(0)
		expect(socket.sent.some(message => message.event === 'pusher:subscribe')).toBe(false)
		client.subscribe('private-race')
		socket.fail()
		await Bun.sleep(15)
		const next = FakeWebSocket.instances[1]
		next.establish('2.3')
		pending[1](null, { auth: 'stale-socket-auth' })
		await Bun.sleep(0)
		expect(next.sent).toEqual([])
		pending[2](null, { auth: 'fresh-auth' })
		await Bun.sleep(0)
		expect(next.sent).toEqual([{ event: 'pusher:subscribe', data: { auth: 'fresh-auth', channel: 'private-race' } }])
	}, { channelAuthorization: { customHandler: (_params, callback) => { pending.push(callback) } } })
})

it('reconnect preserves channel callbacks and ignores messages and closes from replaced sockets', async () => {
	await withFake(async (client, socket) => {
		const states: string[] = []
		client.connection.bind('state_change', data => states.push(data.current))
		socket.establish()
		const channel = client.subscribe('browser-reconnect')
		socket.message('pusher_internal:subscription_succeeded', {}, channel.name)
		const events: unknown[] = []
		channel.bind('update', data => events.push(data))
		socket.fail()
		expect(channel.subscribed).toBe(false)
		expect(client.connection.socket_id).toBeUndefined()
		await Bun.sleep(15)
		const next = FakeWebSocket.instances[1]
		next.establish('2.3')
		expect(next.sent).toEqual([{ event: 'pusher:subscribe', data: { channel: channel.name } }])
		socket.message('pusher_internal:subscription_succeeded', {}, channel.name)
		socket.message('update', { stale: true }, channel.name)
		socket.fail()
		expect(channel.subscribed).toBe(false)
		next.message('pusher_internal:subscription_succeeded', {}, channel.name)
		next.message('update', { fresh: true }, channel.name)
		expect(events).toEqual([{ fresh: true }])
		expect(client.connection.socket_id).toBe('2.3')
		expect(states).toEqual(['connected', 'unavailable', 'connecting', 'connected'])
		client.disconnect()
		await Bun.sleep(25)
		expect(FakeWebSocket.instances.length).toBe(2)
		expect(client.connection.state).toBe('disconnected')
	})
})

it('client heartbeat sends ping, answers server ping and replaces unresponsive peers', async () => {
	await withFake(async (client, socket) => {
		socket.establish()
		socket.message('pusher:ping')
		expect(socket.sent[0]).toEqual({ event: 'pusher:pong', data: {} })
		await Bun.sleep(15)
		expect(socket.sent.some(message => message.event === 'pusher:ping')).toBe(true)
		socket.message('pusher:pong')
		expect(client.connection.state).toBe('connected')
		await Bun.sleep(35)
		expect(socket.readyState).toBe(3)
		expect(FakeWebSocket.instances.length).toBe(2)
	}, { activityTimeout: 10, pongTimeout: 10 })
})

it('terminal protocol errors stop automatic retry; manual connect still works', async () => {
	await withFake(async (client, socket) => {
		socket.establish()
		socket.fail(4001)
		await Bun.sleep(20)
		expect(client.connection.state).toBe('failed')
		expect(FakeWebSocket.instances.length).toBe(1)
		client.connect()
		FakeWebSocket.instances[1].establish('2.3')
		FakeWebSocket.instances[1].message('pusher:error', { code: 4009, message: 'Unauthorized' })
		await Bun.sleep(20)
		expect(client.connection.state).toBe('failed')
		expect(FakeWebSocket.instances.length).toBe(2)
	})
})

it('bind/unbind/global callbacks, Echo registry and client-event send restrictions work', async () => {
	await withFake(async (client, socket) => {
		socket.establish()
		const publicChannel = client.subscribe('browser-events')
		const privateChannel = client.subscribe('private-events')
		expect(privateChannel.trigger('client-update', {})).toBe(false)
		await Bun.sleep(0)
		socket.message('pusher_internal:subscription_succeeded', {}, privateChannel.name)
		socket.message('pusher_internal:subscription_succeeded', {}, publicChannel.name)
		expect(publicChannel.trigger('client-update', {})).toBe(false)
		expect(privateChannel.trigger('update', {})).toBe(false)
		expect(privateChannel.trigger('client-', {})).toBe(false)
		expect(client.channels.channels[privateChannel.name].trigger('client-update', { value: 1 })).toBe(true)
		const calls: unknown[] = []
		const context = { name: 'callback-context' }
		function callback(this: unknown, data: unknown, metadata: unknown) {
			calls.push([this, data, metadata])
		}
		privateChannel.bind('client-update', callback, context)
		const global = (event: string, data: unknown) => calls.push([event, data])
		privateChannel.bind_global(global)
		socket.message('client-update', { value: 2 }, privateChannel.name, 'alice')
		expect(calls).toEqual([[context, { value: 2 }, { user_id: 'alice' }], ['client-update', { value: 2 }]])
		privateChannel.unbind('client-update', callback, context).unbind_global(global)
		socket.message('client-update', {}, privateChannel.name)
		expect(calls.length).toBe(2)
		privateChannel.bind('update', callback).bind_global(global).unbind_all()
		socket.message('update', {}, privateChannel.name)
		expect(calls.length).toBe(2)
		client.unsubscribe(privateChannel.name)
		expect(privateChannel.trigger('client-update', {})).toBe(false)
		expect(() => client.subscribe('private-encrypted-test')).toThrow('Encrypted channels')
		expect(() => client.signin()).toThrow('user authentication is not supported')
	}, { authorizer: () => ({ authorize: (_id, callback) => callback(null, { auth: 'callback-auth' }) }) })
})

it('websocket constructor paths, timeout and options validation are bounded', async () => {
	await withFake(async (client, socket) => {
		expect(socket.url).toBe('wss://localhost:7443/pulse/app/browser-key?protocol=7&client=bun-pulse&version=1.0')
		await Bun.sleep(35)
		expect(socket.readyState).toBe(3)
		expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2)
		expect(client.connection.state).not.toBe('connected')
	}, { forceTLS: true, wssPort: 7443, wsPath: '/pulse/', connectionTimeout: 10 })
	expect(() => new BunPulseClient('key', { wsHost: 'localhost', reconnectDelay: 0 })).toThrow('positive number')
})

it('a connected callback can disconnect without leaving channels pending on the next connection', async () => {
	let authorized = 0
	await withFake(async (client, socket) => {
		const channel = client.subscribe('private-callback-reconnect')
		const disconnect = () => client.disconnect()
		client.connection.bind('connected', disconnect)
		socket.establish()
		expect(client.connection.state).toBe('disconnected')
		expect(channel.subscriptionPending).toBe(false)
		expect(authorized).toBe(0)
		client.connection.unbind('connected', disconnect)
		client.connect()
		const next = FakeWebSocket.instances[1]
		next.establish('2.3')
		await Bun.sleep(0)
		expect(authorized).toBe(1)
		expect(next.sent).toEqual([{ event: 'pusher:subscribe', data: { auth: 'callback-auth', channel: channel.name } }])
		next.message('pusher_internal:subscription_succeeded', {}, channel.name)
		expect(channel.subscribed).toBe(true)
	}, { channelAuthorization: { customHandler: (_params, callback) => {
		authorized++
		callback(null, { auth: 'callback-auth' })
	} } })
})

it('wire errors on subscribed channels remain event errors and keep the subscription active', async () => {
	await withFake(async (client, socket) => {
		socket.establish()
		const channel = client.subscribe('browser-event-error')
		socket.message('pusher_internal:subscription_succeeded', {}, channel.name)
		const errors: unknown[] = []
		const subscriptionErrors: unknown[] = []
		channel.bind('pusher:error', data => errors.push(data))
		channel.bind('pusher:subscription_error', data => subscriptionErrors.push(data))
		socket.message('pusher:error', { message: 'Client event limit exceeded' }, channel.name)
		expect(errors).toEqual([{ message: 'Client event limit exceeded' }])
		expect(subscriptionErrors).toEqual([])
		expect(channel.subscribed).toBe(true)
		expect(channel.subscriptionPending).toBe(false)
		expect(client.connection.state).toBe('connected')
	})
})
