import type { WebhookEvent } from './types'
import { consola } from 'consola'
import { axiom, generateHmacSHA256HexDigest } from './utils'

const DEFAULT_DISCONNECT_DELAY_MS = 1000
const DEFAULT_RETRY_DELAY_MS = 1000
const DEFAULT_RETRY_WINDOW_MS = 5 * 60 * 1000
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 1000

type Fetcher = typeof fetch

interface DeliveryOptions {
	fetcher?: Fetcher
	now?: () => number
	sleep?: (delay: number) => Promise<void>
	retryDelayMs?: number
	retryWindowMs?: number
	requestTimeoutMs?: number
}

export interface WebhookDispatcher {
	send: (event: WebhookEvent) => void
	schedule: (key: string, event: WebhookEvent) => void
	cancel: (key: string) => boolean
}

export const noOpWebhookDispatcher: WebhookDispatcher = {
	send: () => {},
	schedule: () => {},
	cancel: () => false,
}

export async function deliverWebhook(url: string, event: WebhookEvent, appKey: string, secret: string, options: DeliveryOptions = {}): Promise<boolean> {
	const {
		fetcher = fetch,
		now = Date.now,
		sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
		retryDelayMs = DEFAULT_RETRY_DELAY_MS,
		retryWindowMs = DEFAULT_RETRY_WINDOW_MS,
		requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
	} = options
	const payload = JSON.stringify({ time_ms: now(), events: [event] })
	const signature = generateHmacSHA256HexDigest(payload, secret)
	const deliveryStartedAt = now()
	let attempt = 1
	let retryDelay = retryDelayMs
	let status: number | undefined

	while (true) {
		const attemptStartedAt = now()
		status = undefined

		try {
			const response = await fetcher(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Pusher-Key': appKey,
					'X-Pusher-Signature': signature,
				},
				body: payload,
				signal: AbortSignal.timeout(requestTimeoutMs),
			})
			status = response.status

			if (response.ok) {
				logDelivery('delivered', event, attempt, now() - attemptStartedAt, status)
				return true
			}

			consola.warn('Webhook delivery returned a non-2xx response', {
				event: event.name,
				channel: event.channel,
				attempt,
				status,
			})
		}
		catch (error) {
			consola.warn('Webhook delivery failed', {
				event: event.name,
				channel: event.channel,
				attempt,
				error: error instanceof Error ? error.message : String(error),
			})
		}

		if (now() - deliveryStartedAt + retryDelay > retryWindowMs)
			break

		await sleep(retryDelay)
		retryDelay *= 2
		attempt += 1
	}

	logDelivery('failed', event, attempt, now() - deliveryStartedAt, status)
	return false
}

export function createWebhookDispatcher(url?: string, options: { appKey?: string, secret?: string, disconnectDelayMs?: number } = {}): WebhookDispatcher {
	if (!url)
		return noOpWebhookDispatcher

	const appKey = options.appKey ?? import.meta.env.PUSHER_APP_KEY
	const secret = options.secret ?? import.meta.env.PUSHER_APP_SECRET
	if (!appKey || !secret) {
		consola.error('Missing PUSHER_APP_SECRET or PUSHER_APP_KEY. Webhook delivery is disabled.')
		return noOpWebhookDispatcher
	}

	const pending = new Map<string, ReturnType<typeof setTimeout>>()
	const disconnectDelayMs = options.disconnectDelayMs ?? DEFAULT_DISCONNECT_DELAY_MS
	const send = (event: WebhookEvent) => {
		void deliverWebhook(url, event, appKey, secret).catch((error) => {
			consola.error('Unexpected webhook delivery error', {
				event: event.name,
				channel: event.channel,
				error: error instanceof Error ? error.message : String(error),
			})
		})
	}

	return {
		send,
		schedule(key, event) {
			const existingTimeout = pending.get(key)
			if (existingTimeout)
				clearTimeout(existingTimeout)

			pending.set(key, setTimeout(() => {
				pending.delete(key)
				send(event)
			}, disconnectDelayMs))
		},
		cancel(key) {
			const timeout = pending.get(key)
			if (!timeout)
				return false

			clearTimeout(timeout)
			pending.delete(key)
			return true
		},
	}
}

function logDelivery(result: 'delivered' | 'failed', event: WebhookEvent, attempt: number, duration: number, status?: number) {
	const details = {
		app: { id: import.meta.env.PUSHER_APP_ID },
		channel: { name: event.channel },
		webhook: { event: event.name, attempt, duration, result, status },
	}

	if (result === 'delivered')
		consola.success('Webhook delivered', details)
	else
		consola.error('Webhook delivery exhausted its retry window', details)

	axiom.log('pusher_webhook:delivery', details)
}
