import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { startBunPulse } from './index'

const originalAppKey = process.env.PUSHER_APP_KEY
const originalAppSecret = process.env.PUSHER_APP_SECRET

afterEach(() => {
	mock.restore()
	if (originalAppKey === undefined)
		delete process.env.PUSHER_APP_KEY
	else
		process.env.PUSHER_APP_KEY = originalAppKey
	if (originalAppSecret === undefined)
		delete process.env.PUSHER_APP_SECRET
	else
		process.env.PUSHER_APP_SECRET = originalAppSecret
})

describe('startBunPulse', () => {
	it('rejects startup when either app credential is missing', () => {
		spyOn(Bun, 'serve').mockReturnValue({ hostname: 'localhost', port: 6001 } as any)

		for (const missing of ['PUSHER_APP_KEY', 'PUSHER_APP_SECRET'] as const) {
			process.env.PUSHER_APP_KEY = 'app-key'
			process.env.PUSHER_APP_SECRET = 'app-secret'
			delete process.env[missing]

			expect(() => startBunPulse()).toThrow('PUSHER_APP_KEY and PUSHER_APP_SECRET are required')
		}
	})

	it('returns the server and keeps the default port with partial config', () => {
		process.env.PUSHER_APP_KEY = 'app-key'
		process.env.PUSHER_APP_SECRET = 'app-secret'
		const server = { hostname: 'localhost', port: 6001 } as any
		const serve = spyOn(Bun, 'serve').mockReturnValue(server)

		expect(startBunPulse({ webhookUrl: undefined })).toBe(server)
		expect(serve).toHaveBeenCalledWith(expect.objectContaining({ port: 6001 }))
	})
})
