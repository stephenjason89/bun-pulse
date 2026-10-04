import type { Server, ServerWebSocket } from 'bun'
import type { Channels, PublishedEventData, PusherEvent, SubscriptionData, WebSocketData } from './types'
import type { WebhookDispatcher } from './webhook'
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import { consola } from 'consola'
import { WebSocketReadyState } from './types'
import {
	axiom,
	generateHmacSHA256HexDigest,
	generateSocketId,
	getChannelConnections,
	getChannelType,
	messageLogger,
} from './utils'
import { noOpWebhookDispatcher } from './webhook'

const channels: Channels = Object.create(null)
const sockets = new WeakMap<Server, Map<string, ServerWebSocket<WebSocketData>>>()
const clientEventTimes = new WeakMap<ServerWebSocket<WebSocketData>, number[]>()

// Initializes a WebSocket connection with heartbeat settings
export function initializeWebSocketConnection(ws: ServerWebSocket<WebSocketData>, heartbeat: { interval: number, timeout: number, sendPing: boolean }, server?: Server) {
	if (server) {
		let connections = sockets.get(server)
		if (!connections) {
			connections = new Map()
			sockets.set(server, connections)
		}
		connections.set(ws.data.socketId, ws)
	}
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
	const url = new URL(req.url)
	if (url.pathname !== `/app/${import.meta.env.PUSHER_APP_KEY}`)
		return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })

	const success = server.upgrade(req, {
		data: {
			createdAt: Date.now(),
			channel: '',
			auth: '',
			socketId: generateSocketId(),
			origin: req.headers.get('Origin') || 'N/A',
			userAgent: req.headers.get('User-Agent') || 'N/A',
			client: url.searchParams.get('client') || 'N/A',
			version: url.searchParams.get('version') || 'N/A',
			protocol: url.searchParams.get('protocol') || 'N/A',
			subscribedChannels: [],
			subscriptions: Object.create(null),
		},
	})

	if (success) {
		consola.info(`WebSocket upgrade successful for ${url.href}`)
		return undefined // Bun handles the 101 Switching Protocols response
	}
	else {
		consola.error(`WebSocket upgrade failed for ${url.href}`)
		return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
	}
}

// Handles incoming WebSocket messages
export function handleWebSocketMessage(ws: ServerWebSocket<WebSocketData>, message: string | Buffer, server: Server, webhookDispatcher: WebhookDispatcher = noOpWebhookDispatcher, clientEvents = false) {
	try {
		consola.info(`Message Received - Socket ID: ${ws.data.socketId}`)
		let messageObj: PusherEvent
		try {
			messageObj = JSON.parse(String(message))
		}
		catch {
			ws.send(JSON.stringify({ event: 'pusher:error', data: { message: 'Invalid JSON message' } }))
			return
		}
		if (!messageObj || typeof messageObj !== 'object' || Array.isArray(messageObj)) {
			ws.send(JSON.stringify({ event: 'pusher:error', data: { message: 'Invalid message object' } }))
			return
		}
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
				subscribeToChannel(ws, messageObj.data, server, webhookDispatcher)
				break
			case 'pusher:unsubscribe':
				unsubscribeFromChannel(ws, messageObj.data.channel, server, webhookDispatcher)
				break
			default:
				if (typeof messageObj.event === 'string' && messageObj.event.startsWith('client-'))
					publishClientEvent(ws, messageObj, clientEvents, webhookDispatcher)
				else
					consola.error(`Unhandled Event - Event: ${messageObj.event}`)
		}
	}
	catch (error) {
		consola.error(`Message Handling Error - ${error.message}`)
	}
}

function publishClientEvent(ws: ServerWebSocket<WebSocketData>, frame: { event: string, channel?: unknown, data?: unknown }, enabled: boolean, webhookDispatcher: WebhookDispatcher) {
	const reject = (message: string) => {
		ws.send(JSON.stringify({
			event: 'pusher:error',
			...(typeof frame.channel === 'string' ? { channel: frame.channel } : {}),
			data: { message },
		}))
	}
	if (enabled !== true)
		return reject('Client events are disabled')
	if (frame.event.length <= 'client-'.length || frame.event.length > 200)
		return reject('Invalid client event name')
	const channel = frame.channel
	if (typeof channel !== 'string' || channel.length > 200 || !/^(?:private-|presence-)[\w\-=@,.;]+$/.test(channel) || channel.startsWith('private-encrypted-'))
		return reject('Client events require a private or presence channel')
	const subscription = ws.data.subscriptions?.[channel]
	if (!subscription?.auth || !ws.data.subscribedChannels.includes(channel))
		return reject('Client event requires an authorized subscription')
	const isPresenceChannel = channel.startsWith('presence-')
	if (isPresenceChannel && (typeof subscription.user_id !== 'string' || !subscription.user_id))
		return reject('Client event requires an authorized presence identity')
	const serializedData = JSON.stringify(frame.data)
	if (serializedData === undefined)
		return reject('Client event data is required')
	if (Buffer.byteLength(serializedData, 'utf8') > 10240)
		return reject('Client event data exceeds 10KB')
	const now = Date.now()
	const recent = (clientEventTimes.get(ws) ?? []).filter(time => now - time < 1000)
	if (recent.length >= 10)
		return reject('Client event rate limit exceeded')
	recent.push(now)
	clientEventTimes.set(ws, recent)
	ws.publish(channel, JSON.stringify({
		event: frame.event,
		channel,
		data: frame.data,
		...(isPresenceChannel ? { user_id: subscription.user_id } : {}),
	}))
	webhookDispatcher.send({
		name: 'client_event',
		channel,
		event: frame.event,
		socket_id: ws.data.socketId,
		data: serializedData,
		...(isPresenceChannel ? { user_id: subscription.user_id } : {}),
	})
}

// Handles event publishing for POST requests
export async function handleEventPublishing(req: Request, server: Server) {
	try {
		const parsedBody: unknown = await req.json().catch(() => undefined)
		if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody))
			return new Response('Bad Request', { status: 400 })
		const body = parsedBody as { name?: unknown, channel?: unknown, channels?: unknown, data?: unknown, socket_id?: unknown }
		const eventChannels = body.channels ?? (body.channel ? [body.channel] : [])
		if (typeof body.name !== 'string' || !body.name || (typeof body.data !== 'string' && (typeof body.data !== 'object' || body.data === null)) || !Array.isArray(eventChannels) || !eventChannels.length || eventChannels.some(channel => typeof channel !== 'string' || !channel))
			return new Response('Bad Request', { status: 400 })

		if (body.socket_id !== undefined && typeof body.socket_id !== 'string')
			return new Response('Bad Request', { status: 400 })
		const excludedSocket = typeof body.socket_id === 'string' ? sockets.get(server)?.get(body.socket_id) : undefined

		for (const channel of eventChannels) {
			const eventData = { event: body.name, channel, data: body.data }
			const startTime = Date.now()
			if (excludedSocket)
				excludedSocket.publish(channel, JSON.stringify(eventData))
			else
				server.publish(channel, JSON.stringify(eventData))

			axiom.log('pusher_channel:broadcast', {
				app: { id: import.meta.env.PUSHER_APP_ID },
				channel: { name: channel, type: getChannelType(channel) },
				broadcast: {
					event: body.name,
					sockedId: typeof body.data === 'string' ? undefined : (body.data as PublishedEventData).socketId,
					duration: Date.now() - startTime,
					connections: getChannelConnections(channel, channels),
				},
			})

			consola.success(`Event Published - Channel: ${channel}, Event: ${body.name}`)
		}
		return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
	}
	catch (error) {
		consola.error(`Event Publishing Error - ${error.message}`)
		return new Response('Internal Server Error', { status: 500 })
	}
}

// Subscribes the WebSocket to a channel
function subscribeToChannel(ws: ServerWebSocket<WebSocketData>, subscriptionData: SubscriptionData, server: Server, webhookDispatcher: WebhookDispatcher) {
	const isRestrictedChannel = /^(?:private-|presence-)/.test(subscriptionData.channel)
	const isPresenceChannel = getChannelType(subscriptionData.channel) === 'presence'
	const channelData: Extract<SubscriptionData['channel_data'], object> = typeof subscriptionData.channel_data === 'string'
		? JSON.parse(subscriptionData.channel_data || '{}')
		: (subscriptionData.channel_data ?? {})
	const user_id = channelData.user_id
	const user_info = channelData.user_info || {}

	if (isRestrictedChannel && !isAuthorized(ws.data.socketId, subscriptionData)) {
		ws.send(
			JSON.stringify({
				event: 'pusher:error',
				channel: subscriptionData.channel,
				data: {
					message: 'Unauthorized',
				},
			}),
		)
		consola.warn(`Unauthorized Access - Socket ID: ${ws.data.socketId}`)
		return
	}

	// Ensure user_id is present for presence channels
	if (isPresenceChannel && !user_id) {
		ws.send(JSON.stringify({
			event: 'pusher:error',
			channel: subscriptionData.channel,
			data: { message: 'Missing user_id for presence channel' },
		}))
		return
	}

	const { channel, auth = '', channel_data } = subscriptionData
	const existingUserId = Object.keys(channels[channel] ?? {}).find(id => channels[channel][id].sockets.has(ws.data.socketId))
	if (isPresenceChannel && existingUserId !== undefined && existingUserId !== String(user_id)) {
		ws.send(JSON.stringify({
			event: 'pusher:error',
			channel,
			data: { message: 'Already subscribed with a different user_id' },
		}))
		return
	}

	if (existingUserId === undefined) {
		ws.subscribe(channel)
		ws.data.subscriptions ??= Object.create(null)
		ws.data.subscriptions[channel] = {
			auth,
			...(channel_data === undefined ? {} : { channel_data }),
			...(isPresenceChannel ? { user_id: String(user_id) } : {}),
		}
		Object.assign(ws.data, { channel, auth, channel_data })
		if (!ws.data.subscribedChannels.includes(channel))
			ws.data.subscribedChannels.push(channel)
	}
	const canceledVacancy = webhookDispatcher.cancel(channelVacatedWebhookKey(channel))

	if (!channels[channel]) {
		channels[channel] = Object.create(null)
		if (!canceledVacancy) {
			webhookDispatcher.send({ name: 'channel_occupied', channel })
		}
	}

	const user = channels[channel][existingUserId ?? user_id ?? 'guest']

	if (user) {
		// Add this socket to the user's existing connections
		user.sockets.add(ws.data.socketId)
	}
	else {
		const canceledMemberRemoval = isPresenceChannel
			? webhookDispatcher.cancel(memberRemovedWebhookKey(channel, user_id as string))
			: false

		// New user for this channel
		channels[channel][user_id ?? 'guest'] = { user_info, sockets: new Set([ws.data.socketId]) }

		if (isPresenceChannel && !canceledMemberRemoval) {
			webhookDispatcher.send({ name: 'member_added', channel, user_id: user_id as string })
		}
	}

	// Send the initial list of users to the new member
	const members = isPresenceChannel ? Object.entries(channels[channel]).map(([user_id, { user_info }]) => ({ user_id, user_info })) : undefined

	ws.send(JSON.stringify({
		event: 'pusher_internal:subscription_succeeded',
		channel,
		...(isPresenceChannel && { data: JSON.stringify({
			presence: {
				count: members.length,
				ids: members.map(m => m.user_id),
				hash: members.reduce((acc, m) => ({ ...acc, [m.user_id]: m.user_info }), {}),
			},
		}) }),
	}))

	// Notify all members of the new member joining
	if (isPresenceChannel && !user) {
		const startTime = Date.now()
		ws.publish(channel, JSON.stringify({
			event: 'pusher_internal:member_added',
			channel,
			data: JSON.stringify({ user_id, user_info }),
		}))
		axiom.log('pusher_channel:broadcast', {
			app: { id: import.meta.env.PUSHER_APP_ID },
			channel: { name: channel, type: getChannelType(channel) },
			broadcast: {
				event: 'pusher_internal:member_added',
				sockedId: ws.data.socketId,
				duration: Date.now() - startTime,
				connections: getChannelConnections(channel, channels),
			},
		})
	}

	consola.success(`Subscribed - Socket ID: ${ws.data.socketId}, Channel: ${channel}`)
}

// Unsubscribes the WebSocket from a channel
export function unsubscribeFromChannel(ws: ServerWebSocket<WebSocketData>, channel: string, server: Server, webhookDispatcher: WebhookDispatcher = noOpWebhookDispatcher) {
	if (!channel)
		return
	ws.unsubscribe(channel)
	ws.data.subscribedChannels = ws.data.subscribedChannels.filter(subscribedChannel => subscribedChannel !== channel)
	if (ws.data.subscriptions)
		delete ws.data.subscriptions[channel]
	consola.info(`Unsubscribed - Socket ID: ${ws.data.socketId}, Channel: ${channel}`)

	const channelMembers = channels[channel]
	if (!channelMembers)
		return

	const user_id = Object.keys(channelMembers).find(id => channelMembers[id].sockets.has(ws.data.socketId))

	if (user_id) {
		const user = channelMembers[user_id]
		user.sockets.delete(ws.data.socketId)

		// If no more sockets for this user_id, remove user and fire `member_removed`
		if (user.sockets.size === 0) {
			delete channelMembers[user_id]
			if (getChannelType(channel) === 'presence') {
				const startTime = Date.now()
				server.publish(channel, JSON.stringify({
					event: 'pusher_internal:member_removed',
					channel,
					data: JSON.stringify({ user_id }),
				}))
				axiom.log('pusher_channel:broadcast', {
					app: { id: import.meta.env.PUSHER_APP_ID },
					channel: { name: channel, type: getChannelType(channel) },
					broadcast: {
						event: 'pusher_internal:member_removed',
						sockedId: ws.data.socketId,
						duration: Date.now() - startTime,
						connections: getChannelConnections(channel, channels),
					},
				})
				webhookDispatcher.schedule(memberRemovedWebhookKey(channel, user_id), { name: 'member_removed', channel, user_id })
			}

			// If the channel is now empty, trigger the vacancy notification
			if (Object.keys(channelMembers).length === 0) {
				delete channels[channel]
				webhookDispatcher.schedule(channelVacatedWebhookKey(channel), { name: 'channel_vacated', channel })
			}
		}
	}
}

export function unsubscribeFromAllChannels(ws: ServerWebSocket<WebSocketData>, server: Server, webhookDispatcher: WebhookDispatcher = noOpWebhookDispatcher) {
	const connections = sockets.get(server)
	if (connections?.get(ws.data.socketId) === ws)
		connections.delete(ws.data.socketId)
	const subscribedChannels = ws.data.subscribedChannels

	for (const channel of [...subscribedChannels]) {
		unsubscribeFromChannel(ws, channel, server, webhookDispatcher)
	}
}

function channelVacatedWebhookKey(channel: string) {
	return JSON.stringify(['channel_vacated', channel])
}

function memberRemovedWebhookKey(channel: string, userId: string) {
	return JSON.stringify(['member_removed', channel, userId])
}

// Authorizes WebSocket connections
export function isAuthorized(socketId: string, data: SubscriptionData): boolean {
	const channelData = typeof data.channel_data === 'string' ? data.channel_data : JSON.stringify(data.channel_data)
	const stringToSign = data.channel.startsWith('presence-') && channelData
		? `${socketId}:${data.channel}:${channelData}`
		: `${socketId}:${data.channel}`
	const sha256 = generateHmacSHA256HexDigest(stringToSign, String(import.meta.env.PUSHER_APP_SECRET))
	const expectedAuth = `${import.meta.env.PUSHER_APP_KEY}:${sha256}`
	if (typeof data.auth !== 'string')
		return false
	const received = new Uint8Array(Buffer.from(data.auth, 'utf16le'))
	const expected = new Uint8Array(Buffer.from(expectedAuth, 'utf16le'))
	return received.length === expected.length && timingSafeEqual(received, expected)
}
