import type { Channels } from './types'
import { Axiom } from '@axiomhq/js'
import { CryptoHasher } from 'bun'
import { createConsola } from 'consola'

// Simple utility to generate unique socket ID
export function generateSocketId() {
	return `${Math.floor(Date.now() % 1e9)}.${Math.floor(Math.random() * 1e9)}`
}

// Generates a HMAC SHA-256 hex digest for the given message and secret.
export function generateHmacSHA256HexDigest(socketIdChannel: string, secret: string): string {
	const hmac = new CryptoHasher('sha256', secret)
	hmac.update(socketIdChannel)
	return hmac.digest('hex')
}

export const messageLogger = createConsola({
	fancy: true,
	formatOptions: {
		colors: true,
		compact: false,
	},
})

const axiomClient = new Axiom({
	token: import.meta.env.AXIOM_API_KEY,
})

export const axiom = ({
	log: (event: string, data: object) => {
		if (!axiomClient)
			return
		axiomClient.ingest(import.meta.env.AXIOM_DATASET ?? 'bun-pulse', [{ ...data, $event: event }])
	},
})

export const getChannelConnections = (channel: string, channels: Channels): number => Object.values(channels[channel] ?? {}).reduce((total, { sockets }) => total + sockets.size, 0)
export const getChannelType = (channel: string) => (['presence-', 'private-', 'public-']).find(prefix => channel.startsWith(prefix))?.slice(0, -1) || 'unknown'
