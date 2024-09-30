import type { Server, ServerWebSocket } from 'bun'
import type { Buffer } from 'node:buffer'
import type { PusherEvent, WebSocketData } from './types'
import { consola } from 'consola'
import { WebSocketReadyState } from './types'
import { generateHmacSHA256HexDigest, generateSocketId, messageLogger } from './utils'

// Initializes a WebSocket connection with heartbeat settings
export function initializeWebSocketConnection(ws: ServerWebSocket<WebSocketData>, heartbeat: { interval: number, timeout: number, sendPing: boolean }) {
	const connectionData = {
		event: 'pusher:connection_established',
		data: JSON.stringify({ socket_id: ws.data.socketId, activity_timeout: heartbeat.interval / 1000 }),
	}
	ws.send(JSON.stringify(connectionData))
	consola.success(`Connection Established - Socket ID: ${ws.data.socketId}`)
	ws.data.lastPingPong = Date.now()

	const heartbeatInterval = setInterval(() => {
		if (ws.readyState === WebSocketReadyState.OPEN) {
			if (Date.now() - (ws.data.lastPingPong ?? 0) > heartbeat.timeout) {
				consola.warn(`Heartbeat Timeout - Socket ID: ${ws.data.socketId}, Closing connection`)
				ws.close()
				clearInterval(heartbeatInterval)
			}
			else if (heartbeat.sendPing) {
				ws.send(JSON.stringify({ event: 'pusher:ping' }))
			}
		}
		else {
			clearInterval(heartbeatInterval)
		}
	}, heartbeat.interval)
}

// Handles WebSocket upgrade requests
export async function handleWebSocketUpgrade(req: Request, server: Server) {
	const url = req.url
	const success = server.upgrade(req, {
		data: {
			createdAt: Date.now(),
			channel: '',
			auth: '',
			socketId: generateSocketId(),
		},
	})

	if (success) {
		consola.info(`WebSocket upgrade successful for ${url}`)
		return undefined // Bun handles the 101 Switching Protocols response
	}
	else {
		consola.error(`WebSocket upgrade failed for ${url}`)
		return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
	}
}

// Handles incoming WebSocket messages
export function handleWebSocketMessage(ws: ServerWebSocket<WebSocketData>, message: string | Buffer, server: Server, subscriptionVacancyUrl: string) {
	try {
		consola.info(`Message Received - Socket ID: ${ws.data.socketId}`)
		const messageObj = JSON.parse(String(message)) as Omit<PusherEvent, 'channel'>
		messageLogger.box(messageObj)

		switch (messageObj.event) {
			case 'pusher:ping':
				ws.send(JSON.stringify({ event: 'pusher:pong' }))
				ws.data.lastPingPong = Date.now()
				break
			case 'pusher:pong':
				ws.data.lastPingPong = Date.now()
				break
			case 'pusher:subscribe':
				subscribeToChannel(ws, messageObj.data, server)
				break
			case 'pusher:unsubscribe':
				unsubscribeFromChannel(ws, messageObj.data.channel, subscriptionVacancyUrl)
				break
			default:
				consola.error(`Unhandled Event - Event: ${messageObj.event}`)
		}
	}
	catch (error) {
		consola.error(`Message Handling Error - ${error.message}`)
	}
}

// Handles event publishing for POST requests
export async function handleEventPublishing(req: Request, server: Server) {
	try {
		const body = (await req.json()) as PusherEvent
		const eventData = { event: body.name, channel: body.channel, data: body.data }
		server.publish(body.channel, JSON.stringify(eventData))
		consola.success(`Event Published - Channel: ${body.channel}, Event: ${body.name}`)
		return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
	}
	catch (error) {
		consola.error(`Event Publishing Error - ${error.message}`)
		return new Response('Internal Server Error', { status: 500 })
	}
}

// Subscribes the WebSocket to a channel
function subscribeToChannel(ws: ServerWebSocket<WebSocketData>, subscriptionData: WebSocketData, server: Server) {
	if (!isAuthorized(ws.data.socketId, subscriptionData)) {
		ws.send(
			JSON.stringify({
				event: 'pusher:error',
				data: {
					message: 'Unauthorized',
					code: 4009,
				},
			}),
		)
		ws.close()
		consola.warn(`Unauthorized Access - Socket ID: ${ws.data.socketId}`)
		return
	}

	Object.assign(ws.data, subscriptionData)
	ws.subscribe(subscriptionData.channel)

	const eventData = {
		event: 'pusher_internal:subscription_succeeded',
		channel: subscriptionData.channel,
	}
	server.publish(subscriptionData.channel, JSON.stringify(eventData))
	consola.success(`Subscribed - Socket ID: ${ws.data.socketId}, Channel: ${subscriptionData.channel}`)
}

// Unsubscribes the WebSocket from a channel
export function unsubscribeFromChannel(ws: ServerWebSocket<WebSocketData>, channel: string, subscriptionVacancyUrl: string) {
	if (!channel)
		return
	ws.unsubscribe(channel)
	consola.info(`Unsubscribed - Socket ID: ${ws.data.socketId}, Channel: ${channel}`)
	if (subscriptionVacancyUrl)
		notifyChannelVacancy(channel, subscriptionVacancyUrl)
}

// Notifies that a channel has been vacated
async function notifyChannelVacancy(channel: string, subscriptionVacancyUrl: string, retries = 3, delay = 1000) {
	const payload = JSON.stringify({ events: [{ name: 'channel_vacated', channel }] })

	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const response = await fetch(subscriptionVacancyUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: payload,
			})

			if (response.ok) {
				consola.success(`Channel Vacated - Channel: ${channel}`)
				return
			}
			else {
				const errorText = await response.text()
				consola.error(`Channel Vacancy Error - Status: ${response.status}, Error: ${errorText}`)

				if (response.status >= 400 && response.status < 500) {
					// Do not retry for 4xx errors (client-side)
					consola.error('Client error occurred, not retrying...')
					break
				}
			}
		}
		catch (error) {
			consola.error(`Vacancy Notification Error - Channel: ${channel}, Attempt: ${attempt + 1}, Error: ${error.message}`)
		}

		// Retry with exponential backoff
		const backoffTime = delay * 2 ** attempt
		consola.info(`Retrying in ${backoffTime}ms...`)
		await new Promise(resolve => setTimeout(resolve, backoffTime))
	}

	consola.error(`Failed to notify channel vacancy after ${retries + 1} attempts - Channel: ${channel}`)
}

// Authorizes WebSocket connections
export function isAuthorized(socketId: string, data: WebSocketData): boolean {
	const sha256 = generateHmacSHA256HexDigest(`${socketId}:${data.channel}`, String(import.meta.env.PUSHER_APP_SECRET))
	return data.auth === `${import.meta.env.PUSHER_APP_KEY}:${sha256}`
}
