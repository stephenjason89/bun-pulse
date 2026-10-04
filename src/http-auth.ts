import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import { CryptoHasher } from 'bun'
import { generateHmacSHA256HexDigest } from './utils'

interface HttpAuthCredentials {
	appId: string
	appKey: string
	secret: string
}

export async function verifyHttpRequest(req: Request, credentials: HttpAuthCredentials): Promise<Response | undefined> {
	const url = new URL(req.url)
	if (req.method !== 'POST' || url.pathname !== `/apps/${credentials.appId}/events`)
		return new Response('Not Found', { status: 404 })

	const params = url.searchParams
	const keys = [...params.keys()]
	if (new Set(keys).size !== keys.length)
		return new Response('Unauthorized', { status: 401 })

	const timestamp = params.get('auth_timestamp') ?? ''
	const signature = params.get('auth_signature') ?? ''
	const bodyMd5 = params.get('body_md5') ?? ''
	if (params.get('auth_key') !== credentials.appKey || params.get('auth_version') !== '1.0'
		|| !/^\d+$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp))
		|| Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 600
		|| !/^[a-f0-9]{64}$/i.test(signature) || !/^[a-f0-9]{32}$/i.test(bodyMd5)) {
		return new Response('Unauthorized', { status: 401 })
	}

	let body: ArrayBuffer
	try {
		body = await req.arrayBuffer()
	}
	catch {
		return new Response('Unauthorized', { status: 401 })
	}
	if (new CryptoHasher('md5').update(new Uint8Array(body)).digest('hex') !== bodyMd5.toLowerCase())
		return new Response('Unauthorized', { status: 401 })

	const sortedQuery = [...params]
		.filter(([key]) => key !== 'auth_signature')
		.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
		.map(([key, value]) => `${key}=${value}`)
		.join('&')
	const expected = generateHmacSHA256HexDigest(`${req.method}\n${url.pathname}\n${sortedQuery}`, credentials.secret)
	if (!timingSafeEqual(new Uint8Array(Buffer.from(signature, 'hex')), new Uint8Array(Buffer.from(expected, 'hex'))))
		return new Response('Unauthorized', { status: 401 })
}
