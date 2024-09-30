import type { ServerWebSocket } from 'bun'
import type { WebSocketData } from './types'
import { consola } from 'consola'
import {
	handleEventPublishing,
	handleWebSocketMessage,
	handleWebSocketUpgrade,
	initializeWebSocketConnection,
	unsubscribeFromChannel,
} from './websocket'

interface BunPulseConfig {
	port?: number
	subscriptionVacancyUrl?: string
	heartbeat?: {
		interval?: number
		timeout?: number
		sendPing?: boolean
	}
}

export function startBunPulse(config: BunPulseConfig = { port: 6001 }) {
	const { port, subscriptionVacancyUrl, heartbeat = {} } = config
	const finalHeartbeat = { interval: 25000, timeout: 60000, sendPing: false, ...heartbeat }

	const server = Bun.serve({
		port,
		fetch(req, server) {
			if (req.method === 'POST') {
				return handleEventPublishing(req, server)
			}
			return handleWebSocketUpgrade(req, server)
		},
		websocket: {
			message(ws: ServerWebSocket<WebSocketData>, message) {
				handleWebSocketMessage(ws, message, server, subscriptionVacancyUrl)
			},
			open: ws => initializeWebSocketConnection(ws, finalHeartbeat),
			close(ws) {
				consola.info(`Connection closed for Socket ID: ${ws.data.socketId}, Channel: ${ws.data.channel || 'No channel'}`)
				unsubscribeFromChannel(ws, ws.data.channel, subscriptionVacancyUrl)
			},
		},
	})
	consola.success(`WebSocket server listening on ${server.hostname}:${server.port}`)
}
