import { afterEach, expect, it } from 'bun:test'
import { startBunPulse } from './index'

const originalKey = process.env.PUSHER_APP_KEY
const originalSecret = process.env.PUSHER_APP_SECRET

afterEach(() => {
	if (originalKey === undefined)
		delete process.env.PUSHER_APP_KEY
	else
		process.env.PUSHER_APP_KEY = originalKey
	if (originalSecret === undefined)
		delete process.env.PUSHER_APP_SECRET
	else
		process.env.PUSHER_APP_SECRET = originalSecret
})

it('excludes socket_id from HTTP broadcasts and removes disconnected sockets', async () => {
	process.env.PUSHER_APP_KEY = 'exclusion-key'
	process.env.PUSHER_APP_SECRET = 'exclusion-secret'
	const server = startBunPulse({ port: 0, hostname: '127.0.0.1', heartbeat: { interval: 10 } })
	const sockets: WebSocket[] = []
	const connect = async () => {
		const ws = new WebSocket(`ws://127.0.0.1:${server.port}/app/exclusion-key`)
		sockets.push(ws)
		const messages: any[] = []
		ws.addEventListener('message', event => messages.push(JSON.parse(String(event.data))))
		await waitFor(() => messages.some(message => message.event === 'pusher:connection_established'))
		const socketId = JSON.parse(messages[0].data).socket_id
		ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'exclusion-room' } }))
		await waitFor(() => messages.some(message => message.event === 'pusher_internal:subscription_succeeded'))
		return { ws, messages, socketId }
	}
	const publish = (socketId?: string) => fetch(`http://127.0.0.1:${server.port}/apps/test/events`, {
		method: 'POST',
		body: JSON.stringify({ name: 'update', channels: ['exclusion-room'], data: '{}', socket_id: socketId }),
	})
	try {
		const first = await connect()
		const second = await connect()
		expect((await publish(first.socketId)).status).toBe(200)
		await waitFor(() => second.messages.some(message => message.event === 'update'))
		await Bun.sleep(20)
		expect(first.messages.filter(message => message.event === 'update')).toHaveLength(0)
		expect(second.messages.filter(message => message.event === 'update')).toHaveLength(1)
		const closed = new Promise<void>(resolve => first.ws.addEventListener('close', () => resolve(), { once: true }))
		first.ws.close()
		await closed
		await Bun.sleep(20)
		expect((await publish(first.socketId)).status).toBe(200)
		await waitFor(() => second.messages.filter(message => message.event === 'update').length === 2)
		expect((await publish()).status).toBe(200)
		await waitFor(() => second.messages.filter(message => message.event === 'update').length === 3)
	}
	finally {
		for (const ws of sockets)
			ws.close()
		server.stop(true)
	}
}, 5000)

async function waitFor(condition: () => boolean) {
	const deadline = Date.now() + 2000
	while (!condition()) {
		if (Date.now() > deadline)
			throw new Error('Timed out waiting for WebSocket message')
		await Bun.sleep(5)
	}
}
