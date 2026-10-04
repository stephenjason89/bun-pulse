import type { ServeOptions, ServerWebSocket } from 'bun'
import type { WebSocketData } from './types'
import { consola } from 'consola'
import { verifyHttpRequest } from './http-auth'
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
	requireHttpAuth?: boolean
	heartbeat?: {
		interval?: number
		timeout?: number
		sendPing?: boolean
	}
}

export function startBunPulse(config: BunPulseConfig & Partial<ServeOptions> = {}) {
	const appKey = import.meta.env.PUSHER_APP_KEY
	const secret = import.meta.env.PUSHER_APP_SECRET
	if (!appKey || !secret)
		throw new Error('PUSHER_APP_KEY and PUSHER_APP_SECRET are required')

	const { webhookUrl, requireHttpAuth = false, heartbeat = {}, ...serverOptions } = config
	if (typeof requireHttpAuth !== 'boolean')
		throw new Error('requireHttpAuth must be a boolean')
	const appId = import.meta.env.PUSHER_APP_ID
	if (requireHttpAuth && !appId?.trim())
		throw new Error('PUSHER_APP_ID is required when requireHttpAuth is enabled')
	const httpAuth = requireHttpAuth ? { appId, appKey, secret } : undefined
	const finalHeartbeat = { interval: 25000, timeout: 60000, sendPing: false, ...heartbeat }
	const webhookDispatcher = createWebhookDispatcher(webhookUrl)

	const server = Bun.serve({
		port: 6001,
		...serverOptions,
		async fetch(req, server) {
			if (req.method === 'POST') {
				if (httpAuth) {
					const rejected = await verifyHttpRequest(req.clone(), httpAuth)
					if (rejected)
						return rejected
				}
				return handleEventPublishing(req, server)
			}
			return handleWebSocketUpgrade(req, server)
		},
		websocket: {
			message(ws: ServerWebSocket<WebSocketData>, message) {
				handleWebSocketMessage(ws, message, server, webhookDispatcher)
			},
			open: (ws) => {
				initializeWebSocketConnection(ws, finalHeartbeat, server)
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
	return server
}
