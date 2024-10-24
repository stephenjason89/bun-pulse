import { describe, expect, it } from 'bun:test'
import { generateHmacSHA256HexDigest, generateSocketId } from './utils'

// Test Suite
describe('Utility Functions Tests', () => {
	// Test the generateSocketId function
	it('should generate a valid socket ID', () => {
		const socketId = generateSocketId()
		expect(socketId).toMatch(/\d+\.\d+/) // Validate socket ID format
	})

	// Test the generateHmacSHA256HexDigest function
	it('should generate a valid HMAC SHA-256 hex digest', () => {
		const socketIdChannel = 'test-socket-id:test-channel'
		const secret = 'test-secret'
		const digest = generateHmacSHA256HexDigest(socketIdChannel, secret)
		expect(digest).toHaveLength(64) // Validate the length of the SHA-256 hex digest
		expect(digest).toMatch(/^[a-f0-9]+$/) // Validate the format (hex characters)
	})
})
