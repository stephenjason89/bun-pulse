import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { handleEventPublishing, handleWebSocketMessage, initializeWebSocketConnection, unsubscribeFromAllChannels, unsubscribeFromChannel } from './websocket'
import * as websocketModule from './websocket'

describe('BunPulse WebSocket Tests', () => {
	beforeEach(() => {
		spyOn(websocketModule, 'isAuthorized').mockImplementation(() => true)
	})

	// Test WebSocket Connection Initialization
	it('should send connection established message and start heartbeat', () => {
		const wsMock = {
			send: mock(() => {}),
			data: { socketId: 'socket-123', subscribedChannels: [] },
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
		const wsMock: any = {
			send: mock(() => {}),
			close: mock(() => {}),
			data: { socketId: 'socket-123', subscribedChannels: [] },
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
		expect(wsMock.data.subscribedChannels).toEqual(['test-channel'])
		expect(wsMock.send).toHaveBeenCalledWith(JSON.stringify({
			event: 'pusher_internal:subscription_succeeded',
			channel: 'test-channel',
		}))
		expect(mockServer.publish).not.toHaveBeenCalled()
	})

	it('should not subscribe or track presence channels without a user_id', () => {
		const wsMock: any = {
			send: mock(() => {}),
			close: mock(() => {}),
			data: { socketId: 'socket-presence-missing-user', subscribedChannels: [] },
			subscribe: mock(() => {}),
		}

		handleWebSocketMessage(
			wsMock as any,
			JSON.stringify({
				event: 'pusher:subscribe',
				data: { channel: 'presence-test-channel', channel_data: JSON.stringify({ user_info: { name: 'Ada' } }) },
			}),
			{ publish: mock(() => {}) } as any,
			'',
		)

		expect(wsMock.subscribe).not.toHaveBeenCalled()
		expect(wsMock.data.subscribedChannels).toEqual([])
		expect(wsMock.send).toHaveBeenCalledWith(JSON.stringify({
			event: 'pusher:error',
			data: { message: 'Missing user_id for presence channel', code: 4009 },
		}))
		expect(wsMock.close).toHaveBeenCalled()
	})

	it('should ignore unsubscribe for a missing channel entry', () => {
		const wsMock = {
			unsubscribe: mock(() => {}),
			data: { socketId: 'socket-456', subscribedChannels: [] },
		}

		expect(() => unsubscribeFromChannel(wsMock as any, 'missing-channel', {} as any, '')).not.toThrow()
		expect(wsMock.unsubscribe).toHaveBeenCalledWith('missing-channel')
	})

	it('should allow duplicate unsubscribe calls for the same socket and channel', () => {
		const wsMock: any = {
			send: mock(() => {}),
			close: mock(() => {}),
			data: { socketId: 'socket-789', subscribedChannels: [] },
			subscribe: mock(() => {}),
			unsubscribe: mock(() => {}),
		}

		handleWebSocketMessage(
			wsMock as any,
			JSON.stringify({
				event: 'pusher:subscribe',
				data: { channel: 'duplicate-unsubscribe-channel' },
			}),
			{ publish: mock(() => {}) } as any,
			'',
		)

		unsubscribeFromChannel(wsMock as any, 'duplicate-unsubscribe-channel', {} as any, '')
		expect(() => unsubscribeFromChannel(wsMock as any, 'duplicate-unsubscribe-channel', {} as any, '')).not.toThrow()
		expect(wsMock.unsubscribe).toHaveBeenCalledTimes(2)
		expect(wsMock.data.subscribedChannels).toEqual([])
	})

	it('should unsubscribe all successfully joined channels', () => {
		const wsMock: any = {
			send: mock(() => {}),
			close: mock(() => {}),
			data: { socketId: 'socket-multi-channel', subscribedChannels: [] },
			subscribe: mock(() => {}),
			unsubscribe: mock(() => {}),
		}
		const mockServer = { publish: mock(() => {}) }

		for (const channel of ['first-channel', 'second-channel']) {
			handleWebSocketMessage(
				wsMock as any,
				JSON.stringify({
					event: 'pusher:subscribe',
					data: { channel },
				}),
				mockServer as any,
				'',
			)
		}

		expect(wsMock.data.subscribedChannels).toEqual(['first-channel', 'second-channel'])

		unsubscribeFromAllChannels(wsMock as any, mockServer as any, '')

		expect(wsMock.unsubscribe).toHaveBeenCalledWith('first-channel')
		expect(wsMock.unsubscribe).toHaveBeenCalledWith('second-channel')
		expect(wsMock.data.subscribedChannels).toEqual([])
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
