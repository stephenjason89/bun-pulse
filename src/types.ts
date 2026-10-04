export interface WebSocketData {
	createdAt: number
	/** @deprecated Last successful join snapshot. Use subscriptions for current channel state. */
	channel: string
	/** @deprecated Last successful join snapshot. Use subscriptions for current channel state. */
	auth: string
	socketId: string
	origin: string
	userAgent: string
	client: string
	version: string
	protocol: string
	subscribedChannels: string[]
	subscriptions?: Record<string, ChannelSubscription>
	lastPingPong?: number
	/** @deprecated Last successful join snapshot. Use subscriptions for current channel state. */
	channel_data?: string | {
		user_id?: string
		user_info?: Record<string, any>
	}
	[key: string]: any
}

export interface SubscriptionData {
	channel: string
	auth?: string
	channel_data?: string | {
		user_id?: string
		user_info?: Record<string, any>
	}
}

export interface ChannelSubscription {
	auth: string
	channel_data?: SubscriptionData['channel_data']
	/** The authorized presence identity for this channel. */
	user_id?: string
}

export interface PublishedEventData {
	socketId?: string
	[key: string]: any
}

export interface PusherEvent {
	name: string
	event: string
	channel: string
	data: SubscriptionData & PublishedEventData
}

export type WebhookEvent = {
	name: 'channel_occupied' | 'channel_vacated'
	channel: string
} | {
	name: 'member_added' | 'member_removed'
	channel: string
	user_id: string
}

export const WebSocketReadyState = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 } as const

export interface Channels {
	[channel: string]: {
		[userId: string]: {
			user_info: Record<string, any>
			sockets: Set<string>
		}
	} | undefined
}
