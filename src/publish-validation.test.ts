import { expect, it, mock } from 'bun:test'
import { handleEventPublishing } from './websocket'

it('rejects malformed JSON and invalid top-level publish bodies without broadcasting', async () => {
	for (const body of ['{', 'null', 'true', '42', '"event"', '[]']) {
		const server = { publish: mock(() => {}) }
		const response = await handleEventPublishing(new Request('http://localhost/legacy-publish', {
			method: 'POST',
			body,
		}), server as any)

		expect(response.status).toBe(400)
		expect(server.publish).not.toHaveBeenCalled()
	}
})

it('validates every channel before broadcasting any part of the request', async () => {
	for (const channelFields of [
		{ channels: ['valid-channel', null] },
		{ channels: ['valid-channel', ''] },
		{ channels: 'valid-channel' },
		{ channel: { name: 'invalid-channel' } },
	]) {
		const server = { publish: mock(() => {}) }
		const response = await handleEventPublishing(new Request('http://localhost/legacy-publish', {
			method: 'POST',
			body: JSON.stringify({ name: 'update', data: '{}', ...channelFields }),
		}), server as any)

		expect(response.status).toBe(400)
		expect(server.publish).not.toHaveBeenCalled()
	}
})

it('preserves unsigned legacy routes, singular channels, and object data', async () => {
	const server = { publish: mock((_channel: string, _message: string) => {}) }
	const response = await handleEventPublishing(new Request('http://localhost/legacy-publish', {
		method: 'POST',
		body: JSON.stringify({ name: 'update', channel: 'legacy-channel', data: { value: 42 } }),
	}), server as any)

	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({})
	expect(server.publish).toHaveBeenCalledWith('legacy-channel', JSON.stringify({
		event: 'update',
		channel: 'legacy-channel',
		data: { value: 42 },
	}))
})

it('keeps internal broadcast failures as server errors', async () => {
	const server = { publish: mock(() => {
		throw new Error('broadcast failed')
	}) }
	const response = await handleEventPublishing(new Request('http://localhost/apps/app-id/events', {
		method: 'POST',
		body: JSON.stringify({ name: 'update', channels: ['valid-channel'], data: '{}' }),
	}), server as any)

	expect(response.status).toBe(500)
	expect(server.publish).toHaveBeenCalledTimes(1)
})
