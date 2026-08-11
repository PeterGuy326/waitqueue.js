export class HookUrlPolicyError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'HookUrlPolicyError'
	}
}

export interface HookUrlPolicyOptions {
	allowPrivate?: boolean
}

function normalizedHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
}

function ipv4Octets(address: string): number[] | undefined {
	const parts = address.split('.')
	if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined
	const octets = parts.map(Number)
	return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : undefined
}

function isNonPublicIpv4(address: string): boolean {
	const octets = ipv4Octets(address)
	if (!octets) return false
	const [a, b, c] = octets
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 0 && (c === 0 || c === 2)) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113) ||
		a >= 224
	)
}

function ipv6Bytes(address: string): number[] | undefined {
	let normalized = address.toLowerCase()
	if (normalized.includes('.')) {
		const lastColon = normalized.lastIndexOf(':')
		const octets = ipv4Octets(normalized.slice(lastColon + 1))
		if (lastColon < 0 || !octets) return undefined
		normalized = `${normalized.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${(
			(octets[2] << 8) |
			octets[3]
		).toString(16)}`
	}

	const halves = normalized.split('::')
	if (halves.length > 2) return undefined
	const left = halves[0] ? halves[0].split(':') : []
	const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
	if (halves.length === 1 && left.length !== 8) return undefined
	const missing = 8 - left.length - right.length
	if (missing < (halves.length === 2 ? 1 : 0)) return undefined
	const groups = [...left, ...Array(missing).fill('0'), ...right]
	if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return undefined
	return groups.flatMap((group) => {
		const value = Number.parseInt(group, 16)
		return [value >> 8, value & 0xff]
	})
}

function isNonPublicIpv6(address: string): boolean {
	const bytes = ipv6Bytes(address)
	if (!bytes) return false
	const unspecified = bytes.every((byte) => byte === 0)
	const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1
	const ipv4Mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff
	if (ipv4Mapped) return isNonPublicIpv4(bytes.slice(12).join('.'))
	const ipv4Compatible = bytes.slice(0, 12).every((byte) => byte === 0)
	if (ipv4Compatible) return isNonPublicIpv4(bytes.slice(12).join('.'))
	const wellKnownNat64 =
		bytes[0] === 0x00 &&
		bytes[1] === 0x64 &&
		bytes[2] === 0xff &&
		bytes[3] === 0x9b &&
		bytes.slice(4, 12).every((byte) => byte === 0)
	if (wellKnownNat64) return isNonPublicIpv4(bytes.slice(12).join('.'))
	const sixToFour = bytes[0] === 0x20 && bytes[1] === 0x02
	if (sixToFour) return isNonPublicIpv4(bytes.slice(2, 6).join('.'))
	return (
		unspecified ||
		loopback ||
		(bytes[0] & 0xfe) === 0xfc ||
		(bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) ||
		(bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) ||
		bytes[0] === 0xff ||
		(bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) ||
		(bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8)
	)
}

export function isPrivateOrLocalHostname(hostname: string): boolean {
	const value = normalizedHostname(hostname)
	if (!value) return true
	if (value.includes(':')) return isNonPublicIpv6(value)
	if (ipv4Octets(value)) return isNonPublicIpv4(value)
	return (
		!value.includes('.') ||
		value === 'localhost' ||
		value.endsWith('.localhost') ||
		value === 'localdomain' ||
		value.endsWith('.localdomain') ||
		value.endsWith('.local') ||
		value === 'internal' ||
		value.endsWith('.internal') ||
		value === 'home.arpa' ||
		value.endsWith('.home.arpa')
	)
}

function parseHttpUrl(value: string, fieldName: string): URL {
	let parsed: URL
	try {
		parsed = new URL(value)
	} catch {
		throw new HookUrlPolicyError(`${fieldName} must be a valid HTTP(S) URL`)
	}

	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new HookUrlPolicyError(`${fieldName} must be a valid HTTP(S) URL`)
	}
	if (parsed.username || parsed.password) {
		throw new HookUrlPolicyError(`${fieldName} must not contain credentials`)
	}
	return parsed
}

export function normalizeAllowedOrigins(values: readonly string[]): readonly string[] {
	const origins = new Set<string>()
	for (const rawValue of values) {
		const value = rawValue.trim()
		if (!value) throw new HookUrlPolicyError('allowed origin must not be empty')
		const parsed = parseHttpUrl(value, 'allowed origin')
		if (
			(parsed.pathname && parsed.pathname !== '/') ||
			parsed.search ||
			parsed.hash ||
			value.includes('?') ||
			value.includes('#')
		) {
			throw new HookUrlPolicyError('allowed origin must not contain a path, query, or fragment')
		}
		origins.add(parsed.origin)
	}
	return Object.freeze([...origins])
}

export class HookUrlPolicy {
	private readonly allowedOrigins: ReadonlySet<string>
	private readonly allowPrivate: boolean
	readonly configurationKey: string

	constructor(origins: readonly string[] = [], options: HookUrlPolicyOptions = {}) {
		const normalizedOrigins = normalizeAllowedOrigins(origins)
		this.allowedOrigins = new Set(normalizedOrigins)
		this.allowPrivate = options.allowPrivate ?? false
		this.configurationKey = JSON.stringify([normalizedOrigins, this.allowPrivate])
	}

	get enforcesPublicAddresses(): boolean {
		return this.allowedOrigins.size > 0 && !this.allowPrivate
	}

	assertAllowedAddress(address: string): void {
		if (this.enforcesPublicAddresses && isPrivateOrLocalHostname(address)) {
			throw new HookUrlPolicyError('hookUrl resolved to a private or local address')
		}
	}

	assertAllowed(value: string): URL {
		const parsed = parseHttpUrl(value, 'hookUrl')
		if (this.allowedOrigins.size > 0 && !this.allowedOrigins.has(parsed.origin)) {
			throw new HookUrlPolicyError('hookUrl origin is not allowed')
		}
		if (this.enforcesPublicAddresses && isPrivateOrLocalHostname(parsed.hostname)) {
			throw new HookUrlPolicyError('hookUrl must not target a private or local address')
		}
		return parsed
	}
}

export const permissiveHookUrlPolicy = new HookUrlPolicy()
