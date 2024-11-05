export interface WebSocketData {
	createdAt: number
	channel: string
	auth: string
	socketId: string
	origin: string
	userAgent: string
	client: string
	version: string
	protocol: string
	lastPingPong?: number
	channel_data?: string | {
		user_id?: string
		user_info?: Record<string, any>
	}
	[key: string]: any
}

export interface PusherEvent {
	name: string
	event: string
	channel: string
	data: WebSocketData
}

export const WebSocketReadyState = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 } as const

export interface Channels {
	[channel: string]: {
		[userId: string]: {
			user_info: Record<string, any>
			sockets: Set<string>
		}
	}
}
