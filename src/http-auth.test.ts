import type { ServeOptions } from 'bun'
import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import PusherServer from 'pusher'
import { startBunPulse } from './index'

const credentials = { appId: 'http-auth-app', key: 'http-auth-key', secret: 'http-auth-secret', host: 'localhost' }
const path = `/apps/${credentials.appId}/events`
const body = '{ "name": "update", "channels": ["private-orders"], "data": "{\\"message\\":\\"你好\\"}" }'
const originalEnv = Object.fromEntries(['PUSHER_APP_ID', 'PUSHER_APP_KEY', 'PUSHER_APP_SECRET'].map(name => [name, process.env[name]]))
const sdk = new PusherServer(credentials)

beforeEach(() => {
	process.env.PUSHER_APP_ID = credentials.appId
	process.env.PUSHER_APP_KEY = credentials.key
	process.env.PUSHER_APP_SECRET = credentials.secret
})

afterEach(() => {
	mock.restore()
	for (const [name, value] of Object.entries(originalEnv)) {
		if (value === undefined)
			delete process.env[name]
		else
			process.env[name] = value
	}
})

function mockedServer(requireHttpAuth: unknown = true) {
	const server = { hostname: 'localhost', port: 6001, publish: mock((_channel: string, _message: string) => {}) }
	const serve = spyOn(Bun, 'serve').mockReturnValue(server as any)
	startBunPulse({ requireHttpAuth } as any)
	const options = serve.mock.calls.at(-1)![0] as ServeOptions
	return { server, fetch: (req: Request) => options.fetch!.call(server as any, req, server as any) }
}

function signedRequest(options: { query?: Record<string, string>, body?: string, requestPath?: string, duplicate?: string, signer?: PusherServer } = {}) {
	const query = new URLSearchParams((options.signer ?? sdk).createSignedQueryString({
		method: 'POST',
		path,
		body,
		params: { B: 'uppercase', a: 'hello world' },
	}))
	if (options.query) {
		for (const [key, value] of Object.entries(options.query))
			query.set(key, value)
		query.delete('auth_signature')
		const sorted = [...query].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
		query.set('auth_signature', createHmac('sha256', credentials.secret).update(`POST\n${path}\n${sorted.map(([key, value]) => `${key}=${value}`).join('&')}`).digest('hex'))
	}
	if (options.duplicate)
		query.append(options.duplicate, query.get(options.duplicate) ?? 'duplicated')
	return new Request(`http://localhost${options.requestPath ?? path}?${query}`, { method: 'POST', body: options.body ?? body })
}

it('rejects unsigned strict-mode requests and preserves default legacy publishing', async () => {
	const strict = mockedServer()
	expect((await strict.fetch(new Request(`http://localhost${path}`, { method: 'POST', body }))).status).toBe(401)
	expect(strict.server.publish).not.toHaveBeenCalled()
	mock.restore()
	delete process.env.PUSHER_APP_ID
	const legacy = mockedServer(false)
	expect((await legacy.fetch(new Request('http://localhost/legacy-publish', { method: 'POST', body }))).status).toBe(200)
	expect(legacy.server.publish).toHaveBeenCalledTimes(1)
})

it('accepts SDK signatures over exact raw bodies and captures credentials at startup', async () => {
	const strict = mockedServer()
	process.env.PUSHER_APP_ID = 'changed-app'
	process.env.PUSHER_APP_KEY = 'changed-key'
	process.env.PUSHER_APP_SECRET = 'changed-secret'
	expect((await strict.fetch(signedRequest())).status).toBe(200)
	expect(strict.server.publish).toHaveBeenCalledWith('private-orders', JSON.stringify({ event: 'update', channel: 'private-orders', data: '{"message":"你好"}' }))
	expect((await strict.fetch(signedRequest({ signer: new PusherServer({ ...credentials, key: 'changed-key', secret: 'changed-secret' }) }))).status).toBe(401)
	expect(strict.server.publish).toHaveBeenCalledTimes(1)
})

it('rejects tampered bodies, routes, keys, versions, hashes, signatures, and duplicated query fields', async () => {
	const strict = mockedServer()
	const invalidSignature = signedRequest()
	const malformedSignature = new URL(invalidSignature.url)
	malformedSignature.searchParams.set('auth_signature', 'z'.repeat(64))
	const shortSignature = new URL(invalidSignature.url)
	shortSignature.searchParams.set('auth_signature', 'a')
	const changedSignature = new URL(invalidSignature.url)
	const signature = changedSignature.searchParams.get('auth_signature')!
	changedSignature.searchParams.set('auth_signature', `${signature[0] === '0' ? '1' : '0'}${signature.slice(1)}`)
	const requests: [Request, number][] = [
		[signedRequest({ body: `${body}\n` }), 401],
		[signedRequest({ requestPath: '/apps/another-app/events' }), 404],
		[signedRequest({ requestPath: '/legacy-publish' }), 404],
		[signedRequest({ query: { auth_key: 'wrong-key' } }), 401],
		[signedRequest({ query: { auth_version: '2.0' } }), 401],
		[signedRequest({ query: { body_md5: '0'.repeat(32) } }), 401],
		...[malformedSignature, shortSignature, changedSignature].map(url => [new Request(url, { method: 'POST', body }), 401] as [Request, number]),
		...['auth_key', 'auth_timestamp', 'auth_version', 'body_md5', 'auth_signature', 'B'].map(duplicate => [signedRequest({ duplicate }), 401] as [Request, number]),
	]
	for (const [request, status] of requests)
		expect((await strict.fetch(request)).status).toBe(status)
	expect(strict.server.publish).not.toHaveBeenCalled()
})

it('rejects correctly signed invalid, expired, and future timestamps', async () => {
	const strict = mockedServer()
	spyOn(Date, 'now').mockReturnValue(1730000000000)
	const timestamp = Math.floor(Date.now() / 1000)
	for (const auth_timestamp of [String(timestamp - 601), String(timestamp + 601), 'NaN', 'Infinity', '1.5', '', '-1'])
		expect((await strict.fetch(signedRequest({ query: { auth_timestamp } }))).status).toBe(401)
	expect(strict.server.publish).not.toHaveBeenCalled()
	for (const auth_timestamp of [String(timestamp - 600), String(timestamp + 600)])
		expect((await strict.fetch(signedRequest({ query: { auth_timestamp } }))).status).toBe(200)
})

it('fails startup for missing app ID or invalid strict-mode configuration', () => {
	spyOn(Bun, 'serve').mockReturnValue({ hostname: 'localhost', port: 6001 } as any)
	for (const appId of [undefined, '', '   ']) {
		if (appId === undefined)
			delete process.env.PUSHER_APP_ID
		else
			process.env.PUSHER_APP_ID = appId
		expect(() => startBunPulse({ requireHttpAuth: true } as any)).toThrow('PUSHER_APP_ID is required when requireHttpAuth is enabled')
	}
	process.env.PUSHER_APP_ID = credentials.appId
	for (const requireHttpAuth of ['false', null, 1])
		expect(() => startBunPulse({ requireHttpAuth } as any)).toThrow('requireHttpAuth must be a boolean')
})

it('accepts actual official SDK trigger requests in strict mode', async () => {
	const server = startBunPulse({ hostname: '127.0.0.1', port: 0, requireHttpAuth: true } as any)
	try {
		const localSdk = new PusherServer({ ...credentials, host: '127.0.0.1', port: String(server.port), useTLS: false, timeout: 2000 })
		expect((await localSdk.trigger('private-orders', 'sdk-update', { value: 42 })).status).toBe(200)
		expect((await fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'POST', body })).status).toBe(401)
		expect((await fetch(`http://127.0.0.1:${server.port}/app/wrong-key`)).status).toBe(404)
	}
	finally {
		server.stop(true)
	}
})
