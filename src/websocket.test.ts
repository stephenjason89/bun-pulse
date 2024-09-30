import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { handleEventPublishing, handleWebSocketMessage, initializeWebSocketConnection } from './websocket'
import * as websocketModule from './websocket'

describe('BunPulse WebSocket Tests', () => {
	beforeEach(() => {
		spyOn(websocketModule, 'isAuthorized').mockImplementation(() => true)
	})

	// Test WebSocket Connection Initialization
	it('should send connection established message and start heartbeat', () => {
		const wsMock = {
			send: mock(() => {}),
			data: { socketId: 'socket-123' },
			readyState: 1,
			close: mock(() => {}),
		}

		const heartbeat = { interval: 25000, timeout: 60000, sendPing: true }

		initializeWebSocketConnection(wsMock as any, heartbeat)

		expect(wsMock.send).toHaveBeenCalledWith(JSON.stringify({
			event: 'pusher:connection_established',
			data: JSON.stringify({ socket_id: 'socket-123', activity_timeout: 25 }),
		}))
		expect(wsMock.send).toHaveBeenCalledTimes(1)
	})

	// Test WebSocket Message Handling (ping-pong)
	it('should handle pusher:ping and respond with pusher:pong', () => {
		const wsMock = {
			send: mock(() => {}),
			data: { socketId: 'socket-123', lastPingPong: Date.now() },
		}

		handleWebSocketMessage(wsMock as any, JSON.stringify({ event: 'pusher:ping' }), {} as any, '')

		expect(wsMock.send).toHaveBeenCalledWith(JSON.stringify({ event: 'pusher:pong' }))
		expect(wsMock.send).toHaveBeenCalledTimes(1)
	})

	// Test WebSocket Subscription Handling
	it('should handle pusher:subscribe', () => {
		const wsMock = {
			send: mock(() => {}),
			close: mock(() => {}),
			data: { socketId: 'socket-123' },
			subscribe: mock(() => {}),
		}

		const mockServer = {
			publish: mock(() => {}),
		}

		handleWebSocketMessage(
			wsMock as any,
			JSON.stringify({
				event: 'pusher:subscribe',
				data: { channel: 'test-channel' },
			}),
			mockServer as any,
			'',
		)

		expect(wsMock.subscribe).toHaveBeenCalledWith('test-channel')
		expect(mockServer.publish).toHaveBeenCalledWith('test-channel', JSON.stringify({
			event: 'pusher_internal:subscription_succeeded',
			channel: 'test-channel',
		}))
	})

	// Test Event Publishing
	it('should publish an event successfully', async () => {
		const reqMock = {
			json: mock(async () => ({
				name: 'my-event',
				channel: 'my-channel',
				data: { message: 'Hello World' },
			})),
		}

		const serverMock = {
			publish: mock(() => {}),
		}

		const res = await handleEventPublishing(reqMock as any, serverMock as any)

		expect(serverMock.publish).toHaveBeenCalledWith(
			'my-channel',
			JSON.stringify({
				event: 'my-event',
				channel: 'my-channel',
				data: { message: 'Hello World' },
			}),
		)

		expect(res.status).toBe(200)
	})
})
