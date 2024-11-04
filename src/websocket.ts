import type { Server, ServerWebSocket } from 'bun'
import type { Buffer } from 'node:buffer'
import type { PusherEvent, WebSocketData } from './types'
import { consola } from 'consola'
import { WebSocketReadyState } from './types'
import { generateHmacSHA256HexDigest, generateSocketId, messageLogger } from './utils'

const channels: Record<string, { [userId: string]: { user_info: Record<string, any>, sockets: Set<string> } }> = {}
const pendingVacatedWebhookTimeouts: Record<string, Timer> = {}

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
				unsubscribeFromChannel(ws, messageObj.data.channel, server, subscriptionVacancyUrl)
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
	const isRestrictedChannel = /^(?:private-|presence-)/.test(subscriptionData.channel)
	const isPresenceChannel = subscriptionData.channel.startsWith('presence-')

	if (isRestrictedChannel && !isAuthorized(ws.data.socketId, subscriptionData)) {
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

	const channelData: Extract<WebSocketData['channel_data'], object> = typeof ws.data.channel_data === 'string'
		? JSON.parse(ws.data.channel_data || '{}')
		: (ws.data.channel_data ?? {})
	const user_id = channelData.user_id
	const user_info = channelData.user_info || {}

	// Ensure user_id is present for presence channels
	if (isPresenceChannel && !user_id) {
		ws.send(JSON.stringify({
			event: 'pusher:error',
			data: { message: 'Missing user_id for presence channel', code: 4009 },
		}))
		ws.close()
		return
	}

	if (!channels[subscriptionData.channel]) {
		channels[subscriptionData.channel] = {}
	}

	const user = channels[subscriptionData.channel][user_id ?? 'guest']

	if (user) {
		// Add this socket to the user's existing connections
		user.sockets.add(ws.data.socketId)
	}
	else {
		// New user for this channel
		channels[subscriptionData.channel][user_id ?? 'guest'] = { user_info, sockets: new Set([ws.data.socketId]) }

		// Notify all members of the new member joining
		if (isPresenceChannel) {
			server.publish(subscriptionData.channel, JSON.stringify({
				event: 'pusher_internal:member_added',
				channel: subscriptionData.channel,
				data: JSON.stringify({ user_id, user_info }),
			}))
		}
	}

	// Send the initial list of users to the new member
	const members = isPresenceChannel ? Object.values(channels[subscriptionData.channel]).map(({ user_info }, user_id) => ({ user_id, user_info })) : undefined

	ws.send(JSON.stringify({
		event: 'pusher_internal:subscription_succeeded',
		channel: subscriptionData.channel,
		...(isPresenceChannel && { data: JSON.stringify({
			presence: {
				count: members.length,
				ids: members.map(m => m.user_id),
				hash: members.reduce((acc, m) => ({ ...acc, [m.user_id]: m.user_info }), {}),
			},
		}) }),
	}))

	consola.success(`Subscribed - Socket ID: ${ws.data.socketId}, Channel: ${subscriptionData.channel}`)
}

// Unsubscribes the WebSocket from a channel
export function unsubscribeFromChannel(ws: ServerWebSocket<WebSocketData>, channel: string, server: Server, subscriptionVacancyUrl: string) {
	if (!channel)
		return
	ws.unsubscribe(channel)
	consola.info(`Unsubscribed - Socket ID: ${ws.data.socketId}, Channel: ${channel}`)

	const user_id = Object.keys(channels[channel]).find(id => channels[channel][id].sockets.has(ws.data.socketId))

	if (user_id) {
		const user = channels[channel][user_id]
		user.sockets.delete(ws.data.socketId)

		// If no more sockets for this user_id, remove user and fire `member_removed`
		if (user.sockets.size === 0) {
			delete channels[channel][user_id]
			if (channel.startsWith('presence-')) {
				server.publish(channel, JSON.stringify({
					event: 'pusher_internal:member_removed',
					channel,
					data: JSON.stringify({ user_id }),
				}))
			}

			// If the channel is now empty, trigger the vacancy notification
			if (Object.keys(channels[channel]).length === 0) {
				delete channels[channel]
				if (subscriptionVacancyUrl) {
					notifyChannelVacancy(channel, subscriptionVacancyUrl)
				}
			}
		}
	}
}

// Notifies that a channel has been vacated
async function notifyChannelVacancy(channel: string, subscriptionVacancyUrl: string, retries = 3, delay = 1000) {
	const payload = JSON.stringify({ events: [{ name: 'channel_vacated', channel }] })

	// Check if PUSHER_APP_SECRET and PUSHER_APP_KEY are defined
	const secret = import.meta.env.PUSHER_APP_SECRET
	const appKey = import.meta.env.PUSHER_APP_KEY

	if (!secret || !appKey) {
		consola.error('Missing PUSHER_APP_SECRET or PUSHER_APP_KEY. Skipping webhook notification.')
		return
	}

	// Clear any existing pending webhook for this channel to avoid duplicate requests
	if (pendingVacatedWebhookTimeouts[channel]) {
		clearTimeout(pendingVacatedWebhookTimeouts[channel])
		delete pendingVacatedWebhookTimeouts[channel]
	}

	// Set up a delayed webhook notification
	pendingVacatedWebhookTimeouts[channel] = setTimeout(async () => {
		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				const response = await fetch(subscriptionVacancyUrl, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'X-Pusher-Signature': generateHmacSHA256HexDigest(payload, secret),
						'X-Pusher-Key': appKey,
					},
					body: payload,
				})

				if (response.ok) {
					consola.success(`Channel Vacated - Channel: ${channel}`)
					delete pendingVacatedWebhookTimeouts[channel]
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
		delete pendingVacatedWebhookTimeouts[channel]
	}, 1000)
}

// Authorizes WebSocket connections
export function isAuthorized(socketId: string, data: WebSocketData): boolean {
	const sha256 = generateHmacSHA256HexDigest(`${socketId}:${data.channel}`, String(import.meta.env.PUSHER_APP_SECRET))
	return data.auth === `${import.meta.env.PUSHER_APP_KEY}:${sha256}`
}
