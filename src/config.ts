import { networkInterfaces } from 'node:os'
import type { DropdownChoice, SomeCompanionConfigField } from '@companion-module/base'

export const UPDATE_MINIMUM = 250
/**
 * Dante devices advertise their SRV records with a 120s TTL, and RFC 6762 has a resolver refresh an
 * active query at 80% of that - so a poll slower than ~96s leaves the module's view of the network
 * staler than the records it is built from. 60s stays clear of that, and keeps the timeout it
 * implies (twice the interval) at the TTL rather than beyond it.
 */
export const UPDATE_MAXIMUM = 60000

export const TIMEOUT_MINIMUM = 1000
/**
 * Long enough to ride out a badly lossy network, short enough that an unplugged device does not sit
 * on a button looking healthy. Beyond this the module is not reporting the network, it is
 * remembering it.
 */
export const TIMEOUT_MAXIMUM = 300000

/**
 * The groups of variables a connection can publish, with how the config field names them - see
 * {@link ModuleConfig.createVariables}.
 */
export const VARIABLE_GROUPS = {
	/** A variable per device property, plus the `devices` list. */
	device: 'Device properties',
	/** The per-channel routing variables - see `DanteRoutingVariables`. */
	routing: 'Routing',
} as const

export type VariableGroup = keyof typeof VARIABLE_GROUPS

export type ModuleConfig = {
	/**
	 * The chosen network card, as `mac|address`.
	 *
	 * Named for the hardware address because that is what identifies the card across reboots and
	 * lease changes. Empty means automatic, resolved per device. Configurations saved before this held a bare
	 * IPv4 address; those still resolve, and are rewritten to the `mac|address` form on first
	 * connect - see `resolveConfiguredInterface`.
	 */
	mac: string
	interval: number
	timeoutInterval: number
	/**
	 * Which groups of variables to publish ({@link VARIABLE_GROUPS}), chosen in one multi-select so
	 * that a finer split later is one more choice rather than one more checkbox. Read it through
	 * {@link variablesEnabled}.
	 *
	 * - `device`: a variable per device property. Without it the module still tracks every property,
	 *   since the Device Property feedback reads the same values; it simply does not create variables
	 *   for them.
	 * - `routing`: the per-channel routing variables. A router integration needs these and not the
	 *   device properties. Not chosen by default: on a large network they are a great many variables,
	 *   so they are opted into.
	 *
	 * Replaced the `variables` and `routingVariables` checkboxes - see the upgrade scripts.
	 */
	createVariables: VariableGroup[]
	/**
	 * Whether the router panel presets are generated. Off by default: they are one button per
	 * channel and per source mode, which on a large network is a great many presets. The router
	 * actions and feedbacks are available either way.
	 */
	routerPresets: boolean
	/** Which devices get router presets - see {@link routerPresetDeviceFilter}. */
	routerPresetsFilter: RouterPresetsFilter
	/** The device names `routerPresetsFilter` excludes or includes, comma separated, `*` as a wildcard. */
	routerPresetsDevices: string
	verbose: boolean
}

export type RouterPresetsFilter = 'all' | 'exclude' | 'include'

/**
 * Whether a device gets router presets under this config. `exclude` keeps every device but the
 * listed ones, `include` keeps only the listed ones; anything else, a missing setting included,
 * keeps them all. Names are matched whole and case-insensitively, `*` standing for any run of
 * characters, so `MXN5-*` lists every device whose name starts with `MXN5-`.
 */
export function routerPresetDeviceFilter(
	config: Partial<Pick<ModuleConfig, 'routerPresetsFilter' | 'routerPresetsDevices'>> | undefined,
): (deviceName: string) => boolean {
	const mode = config?.routerPresetsFilter
	if (mode !== 'exclude' && mode !== 'include') return () => true
	const patterns = deviceNamePatterns(config?.routerPresetsDevices)
	const listed = (name: string) => patterns.some((pattern) => pattern.test(name))
	return mode === 'exclude' ? (name) => !listed(name) : listed
}

function deviceNamePatterns(list: unknown): RegExp[] {
	if (typeof list !== 'string') return []
	return list
		.split(/[,;\n]/)
		.map((entry) => entry.trim())
		.filter((entry) => entry !== '')
		.map((entry) => {
			const source = entry
				.split('*')
				.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
				.join('.*')
			return new RegExp(`^${source}$`, 'i')
		})
}

/**
 * Whether a connection publishes the variables in `group`. A saved config isn't checked against its
 * field, so anything but a list reads as no groups at all.
 */
export function variablesEnabled(
	config: Pick<ModuleConfig, 'createVariables'> | undefined,
	group: VariableGroup,
): boolean {
	const groups: unknown = config?.createVariables
	return Array.isArray(groups) && groups.includes(group)
}

/** One IPv4 address on one network card. */
export interface NetworkInterfaceInfo {
	/** Interface name, e.g. `en8`. */
	name: string
	address: string
	/** Lower-case, colon-separated. May be all zeroes on some virtual interfaces. */
	mac: string
	netmask: string
}

/** Every external IPv4 address on this machine, with the card it belongs to. */
export function listNetworkInterfaces(): NetworkInterfaceInfo[] {
	const found: NetworkInterfaceInfo[] = []
	const nets = networkInterfaces()
	for (const name of Object.keys(nets)) {
		for (const net of nets[name] ?? []) {
			// Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses.
			// @types/node still types `family` as the literal 'IPv4'/'IPv6', but on Node 18+ it is
			// actually reported as the number 4 or 6 at runtime - check against whichever this Node returns.
			const familyV4Value: string | number = typeof net.family === 'string' ? 'IPv4' : 4
			if ((net.family as unknown as string | number) === familyV4Value && !net.internal) {
				found.push({
					name,
					address: net.address,
					mac: (net.mac ?? '').toLowerCase(),
					netmask: net.netmask ?? '',
				})
			}
		}
	}
	return found
}

/** A MAC that identifies no real card, and so cannot be used to find one again. */
function isUsableMac(mac: string): boolean {
	return mac !== '' && mac !== '00:00:00:00:00:00'
}

/**
 * The config value stored for a chosen network card.
 *
 * An address alone is not a stable identity: a link-local or DHCP card gets a different one after
 * a reboot or lease change, and the module then cannot bind. The MAC survives that, so it is
 * stored alongside the address and used to find the card again when the address has moved. The
 * address is kept as well, so a card carrying several addresses still resolves to the chosen one.
 */
export function encodeInterfaceId(nic: NetworkInterfaceInfo): string {
	return isUsableMac(nic.mac) ? `${nic.mac}|${nic.address}` : nic.address
}

export interface ResolvedInterface {
	nic: NetworkInterfaceInfo
	/**
	 * `address` - the stored address is still present.
	 * `mac` - the address moved and the card was found by its MAC instead.
	 */
	matchedBy: 'address' | 'mac'
}

/**
 * Finds the configured network card among those currently present.
 *
 * Accepts both the `mac|address` form and a bare address, so configurations saved before the MAC
 * was recorded keep working. Returns undefined for an empty value, which means "all interfaces".
 */
export function resolveConfiguredInterface(
	configValue: string,
	available: NetworkInterfaceInfo[],
): ResolvedInterface | undefined {
	if (!configValue) return undefined

	const separator = configValue.indexOf('|')
	const mac = separator === -1 ? '' : configValue.slice(0, separator).toLowerCase()
	const address = separator === -1 ? configValue : configValue.slice(separator + 1)

	// Prefer the exact address: on a card with several addresses it is the one that was chosen.
	const byAddress = available.find((nic) => nic.address === address)
	if (byAddress) return { nic: byAddress, matchedBy: 'address' }

	// The address moved. Find the same card by MAC and use whatever address it holds now.
	if (isUsableMac(mac)) {
		const byMac = available.find((nic) => nic.mac === mac)
		if (byMac) return { nic: byMac, matchedBy: 'mac' }
	}

	return undefined
}

/**
 * The timeout the module actually uses, which is never less than two poll intervals.
 *
 * A device that broadcasts heartbeats is kept alive by those whatever the poll is doing, but one
 * only seen through discovery - a software controller, for instance - is kept alive solely by the
 * poll. If its timeout can expire between two polls it drops and is rediscovered in a loop,
 * rebuilding every action and feedback definition each time. Two intervals leaves room for one late
 * or lost reply, so a configured value below that is raised rather than obeyed.
 */
export function effectiveTimeout(config: Pick<ModuleConfig, 'interval' | 'timeoutInterval'>): number {
	return Math.max(config.timeoutInterval, config.interval * 2)
}

/** Shows the timeout warning field exactly when `effectiveTimeout` would override the configured value. */
const TIMEOUT_WARNING_EXPRESSION = `$(options:timeoutInterval) < $(options:interval) * 2`

/** The router preset filter fields only matter while the presets are generated. */
const ROUTER_PRESETS_EXPRESSION = `$(options:routerPresets)`

export function GetConfigFields(): SomeCompanionConfigField[] {
	// "Automatic" rather than "All": the module listens on every interface for discovery, but a
	// command to a device is sent carrying the address of the one interface that reaches it. Nothing acts
	// on all interfaces at once, so naming it that way invited the wrong expectation.
	const nicChoices: DropdownChoice<string>[] = [{ id: '', label: 'Automatic (detect per device)' }]
	for (const nic of listNetworkInterfaces()) {
		nicChoices.push({ id: encodeInterfaceId(nic), label: `${nic.name} : ${nic.address}` })
	}

	return [
		{
			type: 'static-text',
			id: 'info',
			width: 12,
			label: '',
			value: 'This module controls Dante devices on the selected network.',
		},

		{
			type: 'dropdown',
			label: 'Network Interface',
			id: 'mac',
			description:
				'Choose the network interface bound to Dante Controller, or leave on Automatic to use whichever ' +
				'interface reaches each device. A chosen interface is remembered by its MAC address, so the ' +
				'connection keeps working if its IP changes (link-local or DHCP).',
			width: 12,
			choices: nicChoices,
			default: nicChoices[0]?.id ?? '',
		},

		{
			type: 'number',
			id: 'interval',
			label: 'Update Interval',
			description: 'The time in milliseconds to periodically discover new devices.',
			width: 3,
			default: 1000,
			min: UPDATE_MINIMUM,
			max: UPDATE_MAXIMUM,
			asInteger: true,
			disableAutoExpression: true,
		},

		{
			type: 'number',
			id: 'timeoutInterval',
			label: 'Timeout Interval',
			description:
				'The time in milliseconds before a device is considered offline. Set this to at least twice ' +
				'the Update Interval, or devices that do not send heartbeats may drop and reappear between polls.',
			width: 3,
			default: 3000,
			min: TIMEOUT_MINIMUM,
			max: TIMEOUT_MAXIMUM,
			asInteger: true,
			disableAutoExpression: true,
		},

		{
			type: 'static-text',
			id: 'timeoutWarning',
			label: 'Warning',
			width: 6,
			value:
				'The Timeout Interval is less than twice the Update Interval, so a device that does not ' +
				'send heartbeats can time out between two polls and be dropped. Twice the Update Interval ' +
				'is being used instead.',
			isVisibleExpression: TIMEOUT_WARNING_EXPRESSION,
		},

		{
			type: 'multidropdown',
			id: 'createVariables',
			label: 'Create Variables',
			description:
				'Device properties: a variable for every device property. Leave it out to keep the ' +
				'connection light and read device properties through the Device Property feedback instead. ' +
				'Routing: a variable per channel with its name and, for receive channels, what it is ' +
				'subscribed to and the state of that subscription, plus each device name. Router ' +
				'integrations need these. Not chosen by default: a large network has a great many of them.',
			width: 12,
			choices: Object.entries(VARIABLE_GROUPS).map(([id, label]) => ({ id, label })),
			default: ['device'] satisfies VariableGroup[],
			sortSelection: true,
		},

		{
			type: 'checkbox',
			id: 'routerPresets',
			label: 'Router Panel Presets',
			width: 12,
			default: false,
			description:
				'Generates ready-made router panel buttons: one per receive channel, two per transmit ' +
				'channel, plus Take/Clear/Cancel. Off by default, as a large network makes a great many of ' +
				'them. The Router actions and feedbacks are available either way.',
		},

		{
			type: 'dropdown',
			id: 'routerPresetsFilter',
			label: 'Router Presets Devices',
			width: 4,
			choices: [
				{ id: 'all', label: 'All devices' },
				{ id: 'exclude', label: 'All devices except' },
				{ id: 'include', label: 'Only these devices' },
			] satisfies { id: RouterPresetsFilter; label: string }[],
			default: 'all' satisfies RouterPresetsFilter,
			isVisibleExpression: ROUTER_PRESETS_EXPRESSION,
		},

		{
			type: 'textinput',
			id: 'routerPresetsDevices',
			label: 'Device Names',
			width: 8,
			default: '',
			tooltip:
				'Dante device names, separated by commas. * matches any characters, for example MXN5-* for ' +
				'every device whose name starts with MXN5-. Not case-sensitive.',
			isVisibleExpression: `${ROUTER_PRESETS_EXPRESSION} && $(options:routerPresetsFilter) != 'all'`,
		},

		{
			type: 'checkbox',
			id: 'verbose',
			label: 'Verbose Logging',
			width: 12,
			default: false,
			description: `Enabling this option will put more detail in the log, which can be useful for troubleshooting purposes.`,
		},
	]
}

/** An IPv4 dotted-quad as a 32-bit number, or undefined if it is not one. */
function toUint32(address: string): number | undefined {
	const parts = address.split('.')
	if (parts.length !== 4) return undefined

	let value = 0
	for (const part of parts) {
		const octet = Number(part)
		if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined
		value = (value << 8) | octet
	}
	return value >>> 0
}

/** Whether `address` falls inside the subnet `nic` is attached to. */
export function addressOnInterface(nic: NetworkInterfaceInfo, address: string): boolean {
	const target = toUint32(address)
	const mask = toUint32(nic.netmask)
	const own = toUint32(nic.address)
	if (target === undefined || mask === undefined || own === undefined || mask === 0) return false
	return (own & mask) >>> 0 === (target & mask) >>> 0
}

/**
 * The network interface whose subnet contains `address`.
 *
 * Used when the interface is chosen automatically rather than explicitly: a command still needs one
 * interface's hardware address for its settings commands, and the interface that can actually reach a
 * discovered device is the right one. Returns undefined if no interface's subnet matches.
 */
export function findInterfaceForAddress(
	available: NetworkInterfaceInfo[],
	address: string,
): NetworkInterfaceInfo | undefined {
	return available.find((nic) => addressOnInterface(nic, address))
}
