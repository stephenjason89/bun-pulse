import { describe, expect, it, mock } from 'bun:test'
import { generateHmacSHA256HexDigest } from './utils'
import { createWebhookDispatcher, deliverWebhook } from './webhook'

describe('webhook delivery', () => {
	it('sends the Pusher payload and signs the exact request body', async () => {
		const fetcher = mock(async () => new Response('{}', { status: 200 }))
		const event = { name: 'member_added', channel: 'presence-team', user_id: 'user-1' } as const

		const delivered = await deliverWebhook('https://example.com/webhooks', event, 'app-key', 'app-secret', {
			fetcher: fetcher as typeof fetch,
			now: () => 1724472000000,
		})

		expect(delivered).toBe(true)
		expect(fetcher).toHaveBeenCalledTimes(1)
		const [url, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
		const body = String(request.body)
		expect(url).toBe('https://example.com/webhooks')
		expect(JSON.parse(body)).toEqual({ time_ms: 1724472000000, events: [event] })
		expect(request.headers).toEqual({
			'Content-Type': 'application/json',
			'X-Pusher-Key': 'app-key',
			'X-Pusher-Signature': generateHmacSHA256HexDigest(body, 'app-secret'),
		})
	})

	it('retries non-2xx responses and network errors within the retry window', async () => {
		let attempt = 0
		let currentTime = 0
		const fetcher = mock(async () => {
			attempt += 1
			if (attempt === 1)
				return new Response('{}', { status: 400 })
			if (attempt === 2)
				throw new Error('connection reset')
			return new Response('{}', { status: 204 })
		})
		const sleep = mock(async (delay: number) => {
			currentTime += delay
		})

		const delivered = await deliverWebhook(
			'https://example.com/webhooks',
			{ name: 'channel_vacated', channel: 'private-orders' },
			'app-key',
			'app-secret',
			{
				fetcher: fetcher as typeof fetch,
				now: () => currentTime,
				sleep,
				retryDelayMs: 100,
				retryWindowMs: 300,
			},
		)

		expect(delivered).toBe(true)
		expect(fetcher).toHaveBeenCalledTimes(3)
		expect(sleep).toHaveBeenNthCalledWith(1, 100)
		expect(sleep).toHaveBeenNthCalledWith(2, 200)
	})

	it('cancels a scheduled disconnect webhook before delivery begins', async () => {
		const originalFetch = globalThis.fetch
		const fetcher = mock(async () => new Response('{}', { status: 200 }))
		globalThis.fetch = fetcher as typeof fetch

		try {
			const dispatcher = createWebhookDispatcher('https://example.com/webhooks', {
				appKey: 'app-key',
				secret: 'app-secret',
				disconnectDelayMs: 5,
			})
			dispatcher.schedule('private-orders', { name: 'channel_vacated', channel: 'private-orders' })

			expect(dispatcher.cancel('private-orders')).toBe(true)
			expect(dispatcher.cancel('private-orders')).toBe(false)
			await Bun.sleep(10)
			expect(fetcher).not.toHaveBeenCalled()

			dispatcher.schedule('presence-team:user-1', { name: 'member_removed', channel: 'presence-team', user_id: 'user-1' })
			await Bun.sleep(10)
			expect(fetcher).toHaveBeenCalledTimes(1)
		}
		finally {
			globalThis.fetch = originalFetch
		}
	})
})
