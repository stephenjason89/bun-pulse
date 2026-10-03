import { afterEach, expect, it, mock } from 'bun:test'
import { generateHmacSHA256HexDigest } from './utils'
import { handleWebSocketMessage, unsubscribeFromAllChannels } from './websocket'

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

it('rejects bad subscription auth without closing existing subscriptions', () => {
	process.env.PUSHER_APP_KEY = 'lifecycle-key'
	process.env.PUSHER_APP_SECRET = 'lifecycle-secret'
	const ws = socket('lifecycle-invalid')
	const server = { publish: mock(() => {}) }
	try {
		handleWebSocketMessage(ws as any, JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'lifecycle-public' } }), server as any)
		handleWebSocketMessage(ws as any, JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'private-rejected', auth: 'invalid' } }), server as any)
		expect(ws.close).not.toHaveBeenCalled()
		expect(ws.data.subscribedChannels).toEqual(['lifecycle-public'])
		const error = JSON.parse(ws.send.mock.calls.at(-1)![0])
		expect(error).toEqual({ event: 'pusher:error', channel: 'private-rejected', data: { message: 'Unauthorized' } })
	}
	finally {
		unsubscribeFromAllChannels(ws as any, server as any)
	}
})

it('acknowledges a presence join before notifying only the other subscribers', () => {
	process.env.PUSHER_APP_KEY = 'lifecycle-key'
	process.env.PUSHER_APP_SECRET = 'lifecycle-secret'
	const ws = socket('lifecycle-presence')
	const server = { publish: mock(() => {}) }
	const calls: string[] = []
	ws.send.mockImplementation(() => {
		calls.push('ack')
	})
	ws.publish.mockImplementation(() => {
		calls.push('member')
	})
	const channel = 'presence-lifecycle-order'
	const channelData = JSON.stringify({ user_id: 'lifecycle-user' })
	const auth = `lifecycle-key:${generateHmacSHA256HexDigest(`${ws.data.socketId}:${channel}:${channelData}`, 'lifecycle-secret')}`
	try {
		handleWebSocketMessage(ws as any, JSON.stringify({ event: 'pusher:subscribe', data: { channel, channel_data: channelData, auth } }), server as any)
		expect(calls).toEqual(['ack', 'member'])
		expect(ws.publish).toHaveBeenCalledTimes(1)
		expect(server.publish).not.toHaveBeenCalled()
		expect(JSON.parse(ws.publish.mock.calls[0][1]).event).toBe('pusher_internal:member_added')
	}
	finally {
		unsubscribeFromAllChannels(ws as any, server as any)
	}
})

function socket(socketId: string) {
	return {
		data: { socketId, subscribedChannels: [] as string[] },
		send: mock((_message: string) => {}),
		publish: mock((_channel: string, _message: string) => {}),
		close: mock(() => {}),
		subscribe: mock(() => {}),
		unsubscribe: mock(() => {}),
	}
}
