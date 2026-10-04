import type { WebhookEvent, WebSocketData } from './types'
import type { WebhookDispatcher } from './webhook'
import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import PusherServer from 'pusher'
import { startBunPulse } from './index'
import { generateHmacSHA256HexDigest } from './utils'
import { handleWebSocketMessage, unsubscribeFromAllChannels, unsubscribeFromChannel } from './websocket'

const originalKey = process.env.PUSHER_APP_KEY
const originalSecret = process.env.PUSHER_APP_SECRET
const key = 'client-webhook-key'
const secret = 'client-webhook-secret'
const sockets: { data: WebSocketData }[] = []
const server = { publish: mock((_channel: string, _message: string) => {}) }

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
	handleWebSocketMessage(socket as any, JSON.stringify({
		event: 'pusher:subscribe',
		data: {
			channel,
			auth: validAuth ? `${key}:${generateHmacSHA256HexDigest(`${socket.data.socketId}:${channel}${signedData}`, secret)}` : 'rejected-signature',
			...(channelData === undefined ? {} : { channel_data: channelData }),
		},
	}), server as any)
	socket.publish.mockClear()
}

function recorder() {
	const events: WebhookEvent[] = []
	const dispatcher: WebhookDispatcher = {
		send: event => events.push(event),
		schedule: () => {},
		cancel: () => false,
	}
	return { events, dispatcher }
}

function trigger(socket: ReturnType<typeof createSocket>, frame: unknown, dispatcher: WebhookDispatcher, enabled = true) {
	handleWebSocketMessage(socket as any, JSON.stringify(frame), server as any, dispatcher, enabled)
}

it('emits one client_event webhook after relay with encoded data and channel-authorized identity', () => {
	const socket = createSocket('client-webhook-accepted')
	const webhook = recorder()
	subscribe(socket, 'private-client-hook')
	subscribe(socket, 'presence-client-hook-alice', 'alice')
	subscribe(socket, 'presence-client-hook-bob', 'bob')
	const order: string[] = []
	socket.publish.mockImplementation(() => order.push('relay'))
	const send = webhook.dispatcher.send
	webhook.dispatcher.send = (event) => {
		order.push('hook')
		send(event)
	}
	for (const [channel, data] of [
		['private-client-hook', 'hello'],
		['presence-client-hook-alice', { message: '你好', user_id: 'untrusted' }],
		['presence-client-hook-bob', null],
	] as const) {
		trigger(socket, { event: 'client-note', channel, data, user_id: 'spoofed', socket_id: 'spoofed' }, webhook.dispatcher)
	}
	expect(order).toEqual(['relay', 'hook', 'relay', 'hook', 'relay', 'hook'])
	expect(webhook.events).toEqual([
		{ name: 'client_event', channel: 'private-client-hook', event: 'client-note', socket_id: socket.data.socketId, data: JSON.stringify('hello') },
		{ name: 'client_event', channel: 'presence-client-hook-alice', event: 'client-note', socket_id: socket.data.socketId, data: JSON.stringify({ message: '你好', user_id: 'untrusted' }), user_id: 'alice' },
		{ name: 'client_event', channel: 'presence-client-hook-bob', event: 'client-note', socket_id: socket.data.socketId, data: 'null', user_id: 'bob' },
	])
})

it('emits no client_event webhook for disabled, unauthorized, unsubscribed, or invalid events', () => {
	const socket = createSocket('client-webhook-rejected')
	const webhook = recorder()
	for (const channel of ['private-client-hook-valid', 'client-hook-public', 'private-encrypted-client-hook'])
		subscribe(socket, channel)
	subscribe(socket, 'private-client-hook-rejected', undefined, false)
	subscribe(socket, 'presence-client-hook-left', 'alice')
	unsubscribeFromChannel(socket as any, 'presence-client-hook-left', server as any)
	const data = { event: 'client-note', channel: 'private-client-hook-valid', data: {} }
	trigger(socket, data, webhook.dispatcher, false)
	for (const channel of ['client-hook-public', 'private-encrypted-client-hook', 'private-client-hook-rejected', 'presence-client-hook-left', 'private-client-hook-missing'])
		trigger(socket, { ...data, channel }, webhook.dispatcher)
	for (const frame of [
		{ event: 'client-note', channel: data.channel },
		{ ...data, event: 'client-' },
		{ ...data, event: `client-${'x'.repeat(194)}` },
		{ ...data, data: 'é'.repeat(5120) },
		null,
		[],
	]) {
		trigger(socket, frame, webhook.dispatcher)
	}
	handleWebSocketMessage(socket as any, '{"event":"client-note",', server as any, webhook.dispatcher, true)
	expect(webhook.events).toEqual([])
	expect(socket.publish).not.toHaveBeenCalled()
	expect(socket.close).not.toHaveBeenCalled()
})

it('emits no extra client_event webhook after the rate limit or a failed relay', () => {
	const socket = createSocket('client-webhook-rate')
	const webhook = recorder()
	subscribe(socket, 'private-client-hook-rate')
	spyOn(Date, 'now').mockReturnValue(10000)
	for (let value = 0; value < 11; value++)
		trigger(socket, { event: 'client-note', channel: 'private-client-hook-rate', data: value }, webhook.dispatcher)
	expect(webhook.events).toHaveLength(10)
	expect(socket.publish).toHaveBeenCalledTimes(10)
	const failed = createSocket('client-webhook-failed-relay')
	subscribe(failed, 'private-client-hook-failed')
	failed.publish.mockImplementation(() => {
		throw new Error('Relay failed')
	})
	trigger(failed, { event: 'client-note', channel: 'private-client-hook-failed', data: {} }, webhook.dispatcher)
	expect(webhook.events).toHaveLength(10)
})

it('delivers actual signed client_event webhook requests from a native WebSocket client', async () => {
	const requests: { raw: string, headers: Pick<Headers, 'get'>, payload: { time_ms: number, events: WebhookEvent[] } }[] = []
	const backend = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(req) {
			const raw = await req.text()
			requests.push({ raw, headers: req.headers, payload: JSON.parse(raw) })
			return new Response('{}')
		},
	})
	const local = startBunPulse({ hostname: '127.0.0.1', port: 0, clientEvents: true, webhookUrl: `http://127.0.0.1:${backend.port}/webhooks`, heartbeat: { interval: 10, timeout: 5000 } })
	const ws = new WebSocket(`ws://127.0.0.1:${local.port}/app/${key}`)
	const messages: any[] = []
	ws.addEventListener('message', event => messages.push(JSON.parse(String(event.data))))
	const sdk = new PusherServer({ appId: 'client-webhook-app', key, secret, host: 'localhost' })
	try {
		await waitFor(() => messages.some(message => message.event === 'pusher:connection_established'))
		const socketId = JSON.parse(messages[0].data).socket_id
		const joins = [['private-client-hook-live', undefined], ['presence-client-hook-live-alice', 'alice'], ['presence-client-hook-live-bob', 'bob']] as const
		for (const [channel, userId] of joins) {
			const auth = sdk.authorizeChannel(socketId, channel, userId ? { user_id: userId } : undefined)
			ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel, ...auth } }))
			await waitFor(() => messages.some(message => message.event === 'pusher_internal:subscription_succeeded' && message.channel === channel))
		}
		for (const [channel] of joins)
			ws.send(JSON.stringify({ event: 'client-note', channel, data: { text: '你好' }, user_id: 'spoofed', socket_id: 'spoofed' }))
		const clientRequests = () => requests.filter(request => request.payload.events[0].name === 'client_event')
		await waitFor(() => clientRequests().length === 3)
		expect(clientRequests().map(request => request.payload.events[0])).toEqual(joins.map(([channel, userId]) => ({
			name: 'client_event',
			channel,
			event: 'client-note',
			data: JSON.stringify({ text: '你好' }),
			socket_id: socketId,
			...(userId ? { user_id: userId } : {}),
		})))
		for (const request of clientRequests()) {
			expect(request.payload.time_ms).toEqual(expect.any(Number))
			expect(request.headers.get('Content-Type')).toBe('application/json')
			expect(request.headers.get('X-Pusher-Key')).toBe(key)
			expect(request.headers.get('X-Pusher-Signature')).toBe(createHmac('sha256', secret).update(request.raw).digest('hex'))
			expect(request.payload.events).toHaveLength(1)
		}
	}
	finally {
		ws.close()
		// Keep the receiver alive through the existing one-second disconnect debounce.
		await Bun.sleep(1100)
		local.stop(true)
		backend.stop(true)
	}
}, 6000)

async function waitFor(condition: () => boolean) {
	const deadline = Date.now() + 2000
	while (!condition()) {
		if (Date.now() > deadline)
			throw new Error('Timed out waiting for client webhook')
		await Bun.sleep(5)
	}
}
