/** Browser-only Pusher protocol client. Never pass an application secret here. */
export interface ChannelAuthorizationData {
	auth: string
	channel_data?: string
}

export type AuthorizationCallback = (error: Error | null, data?: ChannelAuthorizationData | null) => void
export interface ClientOptions {
	wsHost: string
	wsPort?: number
	wssPort?: number
	forceTLS?: boolean
	wsPath?: string
	authEndpoint?: string
	auth?: { headers?: Record<string, string>, params?: Record<string, string | number | boolean> }
	channelAuthorization?: {
		endpoint?: string
		headers?: Record<string, string>
		params?: Record<string, string | number | boolean>
		customHandler?: (params: { socketId: string, channelName: string }, callback: AuthorizationCallback) => void
	}
	authorizer?: (channel: BunPulseChannel, options: ClientOptions) => { authorize: (socketId: string, callback: AuthorizationCallback) => void }
	/** HTTP authorization cookie policy. Defaults to same-origin. */
	authCredentials?: 'omit' | 'same-origin' | 'include'
	activityTimeout?: number
	pongTimeout?: number
	connectionTimeout?: number
	reconnectDelay?: number
	maxReconnectDelay?: number
}

type Callback = (...args: any[]) => void
interface Binding { callback: Callback, context?: unknown }

class Dispatcher {
	private bindings = new Map<string, Binding[]>()
	private globalBindings: Binding[] = []

	bind(event: string, callback: Callback, context?: unknown): this {
		const bindings = this.bindings.get(event) ?? []
		bindings.push({ callback, context })
		this.bindings.set(event, bindings)
		return this
	}

	unbind(event?: string, callback?: Callback, context?: unknown): this {
		for (const [name, bindings] of this.bindings) {
			if (event !== undefined && event !== name)
				continue
			const kept = bindings.filter(binding => (callback !== undefined && callback !== binding.callback) || (context !== undefined && context !== binding.context))
			if (kept.length)
				this.bindings.set(name, kept)
			else
				this.bindings.delete(name)
		}
		return this
	}

	bind_global(callback: Callback, context?: unknown): this {
		this.globalBindings.push({ callback, context })
		return this
	}

	unbind_global(callback?: Callback): this {
		this.globalBindings = callback ? this.globalBindings.filter(binding => binding.callback !== callback) : []
		return this
	}

	unbind_all(): this {
		this.bindings.clear()
		this.globalBindings = []
		return this
	}

	emit(event: string, data?: unknown, metadata?: unknown): void {
		for (const binding of [...(this.bindings.get(event) ?? [])])
			binding.callback.call(binding.context, data, metadata)
		for (const binding of [...this.globalBindings])
			binding.callback.call(binding.context, event, data)
	}
}

export interface Member { id: string, info: unknown }
export class Members {
	members: Record<string, unknown> = Object.create(null)
	count = 0
	me: Member | null = null
	myID: string | null = null

	get(id: string): Member | null {
		return Object.hasOwn(this.members, id) ? { id, info: this.members[id] } : null
	}

	each(callback: (member: Member) => void): void {
		for (const id of Object.keys(this.members))
			callback(this.get(id)!)
	}

	reset(): void {
		this.members = Object.create(null)
		this.count = 0
		this.me = null
		this.myID = null
	}

	setPresence(hash: Record<string, unknown>): void {
		this.members = Object.assign(Object.create(null), hash)
		this.count = Object.keys(this.members).length
		this.me = this.myID === null ? null : this.get(this.myID)
	}

	add(id: string, info: unknown): Member | null {
		if (this.get(id))
			return null
		this.members[id] = info
		this.count++
		return this.get(id)
	}

	remove(id: string): Member | null {
		const member = this.get(id)
		if (member) {
			delete this.members[id]
			this.count--
		}
		return member
	}
}

export class BunPulseChannel extends Dispatcher {
	subscribed = false
	subscriptionPending = false
	members = new Members()
	/** Invalidates outstanding authorization when unsubscribed or reconnected. */
	request = 0

	constructor(public name: string, private client: BunPulseClient) {
		super()
	}

	trigger(event: string, data: unknown): boolean {
		if (!event.startsWith('client-') || event.length <= 7 || !/^(?:private-|presence-)/.test(this.name) || this.name.startsWith('private-encrypted-') || !this.subscribed || this.client.channel(this.name) !== this)
			return false
		return this.client.send({ event, channel: this.name, data })
	}

	reset(): void {
		this.request++
		this.subscribed = false
		this.subscriptionPending = false
		this.members.reset()
	}
}

export type ConnectionState = 'initialized' | 'connecting' | 'connected' | 'unavailable' | 'failed' | 'disconnected'
export class ClientConnection extends Dispatcher {
	state: ConnectionState = 'initialized'
	socket_id?: string

	constructor(private client: BunPulseClient) {
		super()
	}

	connect(): void { this.client.connect() }
	disconnect(): void { this.client.disconnect() }

	setState(state: ConnectionState): void {
		if (state === this.state)
			return
		const previous = this.state
		this.state = state
		this.emit('state_change', { previous, current: state })
		this.emit(state)
	}
}

interface Message { event: string, channel?: string, data?: any, user_id?: string }
function decode(data: any): any {
	if (typeof data !== 'string')
		return data
	try {
		return JSON.parse(data)
	}
	catch { return data }
}

export default class BunPulseClient extends Dispatcher {
	connection = new ClientConnection(this)
	// Laravel Echo's whisper helpers use this Pusher-compatible dictionary.
	channels: { channels: Record<string, BunPulseChannel> } = { channels: Object.create(null) }
	private socket?: WebSocket
	private generation = 0
	private stopped = false
	private retry = 0
	private reconnectTimer?: ReturnType<typeof setTimeout>
	private activityTimer?: ReturnType<typeof setTimeout>
	private pongTimer?: ReturnType<typeof setTimeout>
	private connectionTimer?: ReturnType<typeof setTimeout>
	private activityTimeout = 120000

	constructor(public key: string, public options: ClientOptions) {
		super()
		if (!key || !options.wsHost)
			throw new Error('BunPulseClient requires an application key and wsHost')
		for (const name of ['activityTimeout', 'pongTimeout', 'connectionTimeout', 'reconnectDelay', 'maxReconnectDelay'] as const) {
			if (options[name] !== undefined && (!Number.isFinite(options[name]) || options[name]! <= 0))
				throw new Error(`${name} must be a positive number`)
		}
		this.connect()
	}

	connect(): void {
		if (this.socket || this.connection.state === 'connected')
			return
		this.stopped = false
		clearTimeout(this.reconnectTimer)
		this.connection.setState('connecting')
		const generation = ++this.generation
		const tls = this.options.forceTLS !== false
		const port = tls ? (this.options.wssPort ?? 443) : (this.options.wsPort ?? 80)
		const path = (this.options.wsPath ?? '').replace(/\/$/, '')
		const url = new URL(`${tls ? 'wss' : 'ws'}://${this.options.wsHost}:${port}${path}/app/${encodeURIComponent(this.key)}`)
		url.search = new URLSearchParams({ protocol: '7', client: 'bun-pulse', version: '1.0' }).toString()
		let socket: WebSocket
		try {
			socket = new WebSocket(url.toString())
		}
		catch (error) {
			this.connection.emit('error', { type: 'WebSocketError', error })
			this.scheduleReconnect()
			return
		}
		this.socket = socket
		const current = () => this.socket === socket && this.generation === generation
		this.connectionTimer = setTimeout(() => {
			if (current())
				this.dropSocket()
		}, this.options.connectionTimeout ?? 10000)
		socket.onmessage = (event) => {
			if (!current())
				return
			let message: Message
			try {
				message = JSON.parse(String(event.data))
				if (!message || typeof message.event !== 'string')
					throw new Error('Invalid protocol message')
			}
			catch (error) {
				this.connection.emit('error', { type: 'MessageParseError', error })
				return
			}
			this.handleMessage(message)
		}
		socket.onerror = (error) => {
			if (current())
				this.connection.emit('error', { type: 'WebSocketError', error })
		}
		socket.onclose = (event) => {
			if (!current())
				return
			this.releaseSocket()
			if (event.code === 1008 || (event.code >= 4000 && event.code < 4100)) {
				this.stopped = true
				this.connection.setState('failed')
			}
			else {
				this.scheduleReconnect()
			}
		}
	}

	disconnect(): void {
		this.stopped = true
		clearTimeout(this.reconnectTimer)
		const socket = this.socket
		this.releaseSocket()
		socket?.close()
		this.connection.setState('disconnected')
	}

	signin(): never {
		throw new Error('Pusher user authentication is not supported')
	}

	subscribe(name: string): BunPulseChannel {
		if (!name || name.length > 200 || !/^[\w=@,.;-]+$/.test(name))
			throw new Error('Invalid channel name')
		if (name.startsWith('private-encrypted-'))
			throw new Error('Encrypted channels are not supported')
		const channel = this.channel(name) ?? (this.channels.channels[name] = new BunPulseChannel(name, this))
		if (this.connection.state === 'connected')
			void this.subscribeChannel(channel)
		return channel
	}

	unsubscribe(name: string): void {
		const channel = this.channel(name)
		if (!channel)
			return
		delete this.channels.channels[name]
		channel.reset()
		this.send({ event: 'pusher:unsubscribe', data: { channel: name } })
	}

	channel(name: string): BunPulseChannel | undefined { return this.channels.channels[name] }
	allChannels(): BunPulseChannel[] { return Object.values(this.channels.channels) }

	send(message: Message): boolean {
		if (!this.socket || this.socket.readyState !== 1 || this.connection.state !== 'connected')
			return false
		try {
			this.socket.send(JSON.stringify(message))
			return true
		}
		catch { return false }
	}

	private releaseSocket(): void {
		this.generation++
		this.socket = undefined
		this.connection.socket_id = undefined
		clearTimeout(this.activityTimer)
		clearTimeout(this.pongTimer)
		clearTimeout(this.connectionTimer)
		for (const channel of this.allChannels())
			channel.reset()
	}

	private dropSocket(): void {
		const socket = this.socket
		this.releaseSocket()
		socket?.close()
		this.scheduleReconnect()
	}

	private scheduleReconnect(): void {
		if (this.stopped)
			return
		this.connection.setState('unavailable')
		const delay = Math.min((this.options.reconnectDelay ?? 1000) * 2 ** Math.min(this.retry++, 16), this.options.maxReconnectDelay ?? 30000)
		clearTimeout(this.reconnectTimer)
		this.reconnectTimer = setTimeout(() => this.connect(), delay)
	}

	private activity(): void {
		clearTimeout(this.activityTimer)
		clearTimeout(this.pongTimer)
		this.activityTimer = setTimeout(() => {
			if (!this.send({ event: 'pusher:ping', data: {} })) {
				this.dropSocket()
				return
			}
			this.pongTimer = setTimeout(() => this.dropSocket(), this.options.pongTimeout ?? 30000)
		}, this.activityTimeout)
	}

	private handleMessage(message: Message): void {
		const generation = this.generation
		const data = decode(message.data)
		if (message.event === 'pusher:connection_established') {
			if (this.connection.state === 'connected')
				return
			if (!data || typeof data.socket_id !== 'string') {
				this.connection.emit('error', { type: 'HandshakeError', data })
				this.dropSocket()
				return
			}
			clearTimeout(this.connectionTimer)
			this.connection.socket_id = data.socket_id
			this.retry = 0
			const serverTimeout = Number(data.activity_timeout) * 1000
			this.activityTimeout = Math.min(this.options.activityTimeout ?? 120000, serverTimeout > 0 && Number.isFinite(serverTimeout) ? serverTimeout : 120000)
			this.connection.setState('connected')
			if (this.generation !== generation)
				return
			for (const channel of this.allChannels())
				void this.subscribeChannel(channel)
		}
		if (this.connection.state === 'connected')
			this.activity()
		if (message.event === 'pusher:ping') {
			this.send({ event: 'pusher:pong', data: {} })
			return
		}
		if (message.event === 'pusher:pong')
			return
		const channel = message.channel ? this.channel(message.channel) : undefined
		if (message.event === 'pusher:error') {
			this.connection.emit('error', { type: 'PusherError', data })
			if (channel?.subscriptionPending) {
				channel.subscriptionPending = false
				channel.emit('pusher:subscription_error', data)
			}
			else if (channel) {
				channel.emit('pusher:error', data)
			}
			if (data?.code >= 4000 && data.code < 4100) {
				this.disconnect()
				this.connection.setState('failed')
			}
			return
		}
		if (channel && message.event === 'pusher_internal:subscription_succeeded' && channel.subscriptionPending) {
			channel.subscriptionPending = false
			channel.subscribed = true
			if (channel.name.startsWith('presence-')) {
				channel.members.setPresence(data?.presence?.hash ?? {})
				channel.emit('pusher:subscription_succeeded', channel.members)
			}
			else { channel.emit('pusher:subscription_succeeded', data) }
			return
		}
		if (channel?.subscribed && message.event === 'pusher_internal:member_added') {
			const member = channel.members.add(String(data.user_id), data.user_info)
			if (member)
				channel.emit('pusher:member_added', member)
			return
		}
		if (channel?.subscribed && message.event === 'pusher_internal:member_removed') {
			const member = channel.members.remove(String(data.user_id))
			if (member)
				channel.emit('pusher:member_removed', member)
			return
		}
		if (!message.event.startsWith('pusher_internal:')) {
			if (channel?.subscribed)
				channel.emit(message.event, data, message.user_id ? { user_id: message.user_id } : undefined)
			this.emit(message.event, data)
		}
	}

	private async subscribeChannel(channel: BunPulseChannel): Promise<void> {
		if (channel.subscribed || channel.subscriptionPending)
			return
		channel.subscriptionPending = true
		const request = ++channel.request
		const socketId = this.connection.socket_id!
		const generation = this.generation
		const current = () => this.generation === generation && this.channel(channel.name) === channel && channel.request === request && this.connection.state === 'connected'
		try {
			const restricted = /^(?:private-|presence-)/.test(channel.name)
			const auth = restricted ? await this.authorize(channel, socketId) : undefined
			if (!current())
				return
			if (channel.name.startsWith('presence-')) {
				const user = decode(auth?.channel_data)
				if (user?.user_id === undefined || user.user_id === null)
					throw new Error('Presence authorization requires channel_data.user_id')
				channel.members.myID = String(user.user_id)
			}
			if (!this.send({ event: 'pusher:subscribe', data: { ...auth, channel: channel.name } }))
				throw new Error('Unable to send subscription')
		}
		catch (error) {
			if (!current())
				return
			channel.subscriptionPending = false
			channel.emit('pusher:subscription_error', { type: 'AuthError', error, status: (error as { status?: number }).status })
		}
	}

	private async authorize(channel: BunPulseChannel, socketId: string): Promise<ChannelAuthorizationData> {
		const authorization = this.options.channelAuthorization
		let result: ChannelAuthorizationData
		if (authorization?.customHandler || this.options.authorizer) {
			result = await new Promise<ChannelAuthorizationData>((resolve, reject) => {
				const callback: AuthorizationCallback = (error, data) => error ? reject(error) : data ? resolve(data) : reject(new Error('Empty authorization response'))
				if (authorization?.customHandler)
					authorization.customHandler({ socketId, channelName: channel.name }, callback)
				else
					this.options.authorizer!(channel, this.options).authorize(socketId, callback)
			})
		}
		else {
			const body = new URLSearchParams()
			for (const [name, value] of Object.entries(authorization?.params ?? this.options.auth?.params ?? {}))
				body.set(name, String(value))
			body.set('socket_id', socketId)
			body.set('channel_name', channel.name)
			const response = await fetch(authorization?.endpoint ?? this.options.authEndpoint ?? '/broadcasting/auth', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(authorization?.headers ?? this.options.auth?.headers) },
				body,
				credentials: this.options.authCredentials ?? 'same-origin',
			})
			if (!response.ok)
				throw Object.assign(new Error(`Authorization failed with status ${response.status}`), { status: response.status })
			result = await response.json() as ChannelAuthorizationData
		}
		if (!result || typeof result.auth !== 'string' || !result.auth)
			throw new Error('Authorization response requires auth')
		return { auth: result.auth, ...(typeof result.channel_data === 'string' && { channel_data: result.channel_data }) }
	}
}
