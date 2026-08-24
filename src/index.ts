import type { ServeOptions, ServerWebSocket } from 'bun'
import type { WebSocketData } from './types'
import { consola } from 'consola'
import { axiom } from './utils'
import { createWebhookDispatcher } from './webhook'
import {
	handleEventPublishing,
	handleWebSocketMessage,
	handleWebSocketUpgrade,
	initializeWebSocketConnection,
	unsubscribeFromAllChannels,
} from './websocket'

interface BunPulseConfig {
	webhookUrl?: string
	/** @deprecated Use webhookUrl instead. */
	subscriptionVacancyUrl?: string
	heartbeat?: {
		interval?: number
		timeout?: number
		sendPing?: boolean
	}
}

export function startBunPulse(config: BunPulseConfig & Partial<ServeOptions> = { port: 6001 }) {
	const { webhookUrl, subscriptionVacancyUrl, heartbeat = {}, ...serverOptions } = config
	const finalHeartbeat = { interval: 25000, timeout: 60000, sendPing: false, ...heartbeat }
	const resolvedWebhookUrl = webhookUrl ?? subscriptionVacancyUrl
	const webhookDispatcher = createWebhookDispatcher(resolvedWebhookUrl)

	if (subscriptionVacancyUrl) {
		consola.warn(webhookUrl
			? 'subscriptionVacancyUrl is deprecated and ignored because webhookUrl is configured.'
			: 'subscriptionVacancyUrl is deprecated. Use webhookUrl instead.')
	}

	const server = Bun.serve({
		...serverOptions,
		fetch(req, server) {
			if (req.method === 'POST') {
				return handleEventPublishing(req, server)
			}
			return handleWebSocketUpgrade(req, server)
		},
		websocket: {
			message(ws: ServerWebSocket<WebSocketData>, message) {
				handleWebSocketMessage(ws, message, server, webhookDispatcher)
			},
			open: (ws) => {
				initializeWebSocketConnection(ws, finalHeartbeat)
				axiom.log('pusher_connection:open', {
					app: { id: import.meta.env.PUSHER_APP_ID },
					connection: { socketId: ws.data.socketId, origin: ws.data.origin, userAgent: ws.data.userAgent, client: ws.data.client, version: ws.data.version, protocol: ws.data.protocol },
				})
			},
			close(ws, code, reason) {
				consola.info(`Connection closed for Socket ID: ${ws.data.socketId}, Channels: ${ws.data.subscribedChannels.join(', ') || 'No channels'}`)
				unsubscribeFromAllChannels(ws, server, webhookDispatcher)
				axiom.log('pusher_connection:close', {
					app: { id: import.meta.env.PUSHER_APP_ID },
					close: { code, reason },
					connection: { socketId: ws.data.socketId, duration: Date.now() - ws.data.createdAt },
				})
			},
		},
	})
	consola.success(`WebSocket server listening on ${server.hostname}:${server.port}`)
}
