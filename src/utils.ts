import { CryptoHasher } from 'bun'
import { createConsola } from 'consola'

// Simple utility to generate unique socket ID
export function generateSocketId() {
	return `${Math.floor(Date.now() % 1e9)}.${Math.floor(Math.random() * 1e9)}`
}

// Generates a HMAC SHA-256 hex digest for the given message and secret.
export function generateHmacSHA256HexDigest(message: string, secret: string): string {
	const hmac = new CryptoHasher('sha256', secret)
	hmac.update(message)
	return hmac.digest('hex')
}

export const messageLogger = createConsola({
	fancy: true,
	formatOptions: {
		colors: true,
		compact: false,
	},
})
