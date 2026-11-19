/**
 * An X-Y router panel: pick a destination, then a source, optionally confirmed with Take.
 *
 * The selection lives in the module, so a panel needs no custom variables: the destination and
 * source buttons only say which channel they stand for, and the feedbacks and variables below say
 * what is selected and what is routed where. Every router action and feedback carries a Panel
 * option, and buttons with the same Panel share one selection; the default, empty one is shared by
 * the whole connection. Giving each operator, surface or page its own Panel (`$(this:page)` makes
 * one per page) lets several people use the router at once without stepping on each other. Channels are picked by number,
 * as the Crosspoint - Make dropdowns are, and the source's name - which Dante subscribes by - is
 * looked up only when the route is made.
 *
 * Presets are generated from the discovered network: one button per receive channel and one per
 * transmit channel, grouped by device, plus the Take / Clear / Cancel / selection controls.
 */
import {
	combineRgb,
	type CompanionActionDefinitions,
	type CompanionFeedbackDefinitions,
	type CompanionPresetDefinitions,
	type CompanionPresetGroup,
	type CompanionPresetSection,
	type CompanionVariableDefinitions,
	type DropdownChoice,
} from '@companion-module/base'
import {
	CHANNEL_MEDIA_TYPE_LABELS,
	CHANNEL_MEDIA_TYPES,
	channelDisplayLabel,
	channelFieldDevices,
	channelOptionPrefix,
	channelTypeOption,
	clearAudioCrosspointConfirmed,
	clearVideoCrosspointConfirmed,
	DanteCommandError,
	deviceByIdentifier,
	deviceOptionValue,
	firstChoiceId,
	getAudioRxChannelSource,
	getVideoRxChannelSource,
	perDeviceChannelFields,
	perDeviceMissingChannelWarnings,
	resolveDeviceIp,
	rxDeviceChoices,
	SUBSCRIPTION_STATE_NOT_SUBSCRIBED,
	subscriptionStateValue,
	trackFeedbackDevices,
	txDeviceChoices,
	untrackFeedback,
	videoSubscriptionStatusLabel,
	type ChannelMediaType,
} from './api/index.js'
import type { ChannelNumber, DeviceName } from './api/ids.js'
import { makeCrosspointByNumber } from './actions.js'
import { routerPresetDeviceFilter } from './config.js'
import { crosspointConnectedByNumber } from './feedbacks.js'
import type DanteInstance from './main.js'
import type { DanteModuleTypes } from './types.js'
import { sanitiseVariableId } from './utils/sanitise.js'
import { UpdateVariableDefinitions, variablePublisher } from './variables.js'

/** One side of the router selection: a channel, by number, on a device, by name. */
export interface RouterChannel {
	channelType: ChannelMediaType
	device: string
	channel: number
}

export interface RouterState {
	/** The destination the next source press or Take routes to. */
	destination?: RouterChannel
	/** A source picked in Take mode, waiting for Take. */
	pending?: RouterChannel
}

/** The panel buttons belong to when their Panel option is left empty. */
export const DEFAULT_PANEL = ''

/** Each connection's panels, by key. Created on first use, and not kept across restarts. */
const states = new WeakMap<DanteInstance, Map<string, RouterState>>()

/** Panels whose variables are already defined; a new panel needs the definitions rebuilt once. */
const definedPanels = new WeakMap<DanteInstance, Set<string>>()

const NO_SELECTION: Readonly<RouterState> = Object.freeze({})

/**
 * The key of a Panel option value: trimmed and made safe for a variable id, since a named panel
 * publishes its own variables. Empty, missing or non-text values all mean the default panel.
 */
export function routerPanelKey(panel: unknown): string {
	const text = typeof panel === 'string' ? panel.trim() : typeof panel === 'number' ? String(panel) : ''
	return text === '' ? DEFAULT_PANEL : sanitiseVariableId(text)
}

function panelStates(self: DanteInstance): Map<string, RouterState> {
	let byPanel = states.get(self)
	if (!byPanel) {
		byPanel = new Map()
		states.set(self, byPanel)
	}
	return byPanel
}

/** A panel's router selection, created on first use. */
export function routerState(self: DanteInstance, panel: unknown = DEFAULT_PANEL): RouterState {
	const key = routerPanelKey(panel)
	const byPanel = panelStates(self)
	let state = byPanel.get(key)
	if (!state) {
		state = {}
		byPanel.set(key, state)
	}
	return state
}

/** A panel's selection for reading only: a feedback on a panel nobody has used yet creates nothing. */
function peekState(self: DanteInstance, panel: unknown): Readonly<RouterState> {
	return states.get(self)?.get(routerPanelKey(panel)) ?? NO_SELECTION
}

/** The panels used so far on this connection, the default one included, in first-use order. */
export function routerPanels(self: DanteInstance): string[] {
	return [...(states.get(self)?.keys() ?? [])]
}

/** How a source button behaves: route at once, or wait for Take. */
export type RouterSourceMode = 'route' | 'preselect'

/** Which panel a router action or feedback belongs to; see `routerPanelKey`. */
type PanelOptions = { panel: string }

type DestinationOptions = PanelOptions & {
	channelType: ChannelMediaType
	destinationDevice: string
} & Record<`destinationChannel_${string}`, number> &
	Record<`destinationChannelVideo_${string}`, number>

type SourceOptions = PanelOptions & {
	channelType: ChannelMediaType
	sourceDevice: string
} & Record<`sourceChannel_${string}`, number> &
	Record<`sourceChannelVideo_${string}`, number>

type SelectSourceOptions = SourceOptions & { mode: RouterSourceMode }

export type RouterActionSchema = {
	router_select_destination: { options: DestinationOptions }
	router_select_source: { options: SelectSourceOptions }
	router_take: { options: PanelOptions }
	router_clear_destination: { options: PanelOptions }
	router_cancel: { options: PanelOptions }
}

export type RouterFeedbackSchema = {
	router_destination_selected: { type: 'boolean'; options: DestinationOptions }
	router_source_routed: { type: 'boolean'; options: SourceOptions }
	router_source_pending: { type: 'boolean'; options: SourceOptions }
	router_take_armed: { type: 'boolean'; options: PanelOptions }
}

/** What one panel publishes, under `router_` for the default panel and `router_panel_<key>_` for a named one. */
export type RouterPanelVariables = {
	destination_device: string
	destination_channel: string
	destination_label: string
	destination_source: string
	destination_status: string
	pending_device: string
	pending_channel: string
	pending_label: string
}

const ROUTER_PANEL_VARIABLE_NAMES: Record<keyof RouterPanelVariables, string> = {
	destination_device: 'selected destination device',
	destination_channel: 'selected destination channel number',
	destination_label: 'selected destination channel label',
	destination_source: 'source of the selected destination (channel@device)',
	destination_status: 'subscription status of the selected destination',
	pending_device: 'source waiting for Take, device',
	pending_channel: 'source waiting for Take, channel number',
	pending_label: 'source waiting for Take, channel label',
}

/**
 * The router variables: a handful per panel, whatever the network size. The default panel's are
 * concrete keys; a named panel's are only known at runtime, hence the template-literal signature.
 */
export type DanteRouterVariables = {
	[Suffix in keyof RouterPanelVariables as `router_${Suffix}`]: string
} & {
	[Suffix in keyof RouterPanelVariables as `router_panel_${string}_${Suffix}`]: string | undefined
}

/** The prefix of a panel's variable ids. */
export function routerVariablePrefix(panelKey: string): string {
	return panelKey === DEFAULT_PANEL ? 'router_' : `router_panel_${panelKey}_`
}

const ROUTER_FEEDBACKS = [
	'router_destination_selected',
	'router_source_routed',
	'router_source_pending',
	'router_take_armed',
] as const satisfies readonly (keyof RouterFeedbackSchema)[]

function sameChannel(a: RouterChannel | undefined, b: RouterChannel | undefined): boolean {
	return (
		a !== undefined &&
		b !== undefined &&
		a.channelType === b.channelType &&
		a.channel === b.channel &&
		a.device.toLowerCase() === b.device.toLowerCase()
	)
}

/** Re-evaluates the router feedbacks and a panel's variables after its selection changed. */
function selectionChanged(self: DanteInstance, panel: unknown): void {
	self.checkFeedbacks(...ROUTER_FEEDBACKS)
	const key = routerPanelKey(panel)
	ensurePanelVariables(self, key)
	variablePublisher(self).setValues(routerPanelVariableValues(self, key))
}

/**
 * Defines a panel's variables the first time anything refers to it - an action, or a feedback on a
 * button being drawn. A connection that never uses the router publishes none, and a panel's display
 * buttons show its (empty) selection from the start, and after a restart, rather than `$NA`.
 */
function ensurePanelVariables(self: DanteInstance, key: string): void {
	let defined = definedPanels.get(self)
	if (!defined) {
		defined = new Set()
		definedPanels.set(self, defined)
	}
	if (defined.has(key)) return
	defined.add(key)
	routerState(self, key)
	// values are only sent for defined ids, so the definitions come first
	UpdateVariableDefinitions(self)
	// sent as is: the publisher takes a new variable to be empty already and would skip empty values,
	// while the host may show a defined but never set variable as $NA
	self.setVariableValues(routerPanelVariableValues(self, key))
}

/** The selection a feedback reads, making sure its panel's variables exist. */
function feedbackState(self: DanteInstance, panel: unknown): Readonly<RouterState> {
	const key = routerPanelKey(panel)
	ensurePanelVariables(self, key)
	return peekState(self, key)
}

/** The channel a destination dropdown set picks, or undefined when the device has none of that type. */
function destinationFromOptions(self: DanteInstance, opt: DestinationOptions): RouterChannel | undefined {
	const channel = deviceOptionValue<number | undefined>(
		self,
		opt,
		channelOptionPrefix('destinationChannel', opt.channelType),
		opt.destinationDevice,
		undefined,
	)
	if (!opt.destinationDevice || channel === undefined) return undefined
	const name = deviceByIdentifier(self, opt.destinationDevice)?.name ?? opt.destinationDevice
	return { channelType: opt.channelType ?? 'audio', device: name, channel }
}

/** The channel a source dropdown set picks, or undefined when the device has none of that type. */
function sourceFromOptions(self: DanteInstance, opt: SourceOptions): RouterChannel | undefined {
	const channel = deviceOptionValue<number | undefined>(
		self,
		opt,
		channelOptionPrefix('sourceChannel', opt.channelType),
		opt.sourceDevice,
		undefined,
	)
	if (!opt.sourceDevice || channel === undefined) return undefined
	const name = deviceByIdentifier(self, opt.sourceDevice)?.name ?? opt.sourceDevice
	return { channelType: opt.channelType ?? 'audio', device: name, channel }
}

/** Routes `source` to the panel's selected destination, checking that both are of the same type. */
async function routeToDestination(
	self: DanteInstance,
	state: RouterState,
	source: RouterChannel,
	signal: AbortSignal | undefined,
): Promise<void> {
	const destination = state.destination
	if (!destination) throw new DanteCommandError('Router: no destination selected')
	if (destination.channelType !== source.channelType) {
		throw new DanteCommandError(
			`Router: the selected destination is ${CHANNEL_MEDIA_TYPE_LABELS[destination.channelType]}, ` +
				`the source is ${CHANNEL_MEDIA_TYPE_LABELS[source.channelType]}`,
		)
	}
	await makeCrosspointByNumber(
		self,
		destination.channelType,
		destination.device,
		destination.channel,
		source.device,
		source.channel,
		{ signal },
	)
}

/** The display label of a channel: its name, or `Ch <n>` - as the channel dropdowns show it. */
function channelLabel(self: DanteInstance, selection: RouterChannel, direction: 'rx' | 'tx'): string {
	const isVideo = selection.channelType === 'video'
	const byDevice =
		direction === 'rx'
			? isVideo
				? self.videoRxChannelsChoices
				: self.rxChannelsChoices
			: isVideo
				? self.videoTxChannelsChoices
				: self.txChannelsChoices
	const name = deviceByIdentifier(self, selection.device)?.name ?? selection.device
	const choice = byDevice?.[name as DeviceName]?.find((entry) => entry.id === selection.channel)
	return channelDisplayLabel(choice?.label, selection.channel)
}

/** What the selected destination is subscribed to, as `channel@device`, and how that subscription is. */
function destinationSubscription(self: DanteInstance, destination: RouterChannel): { source: string; status: string } {
	const isVideo = destination.channelType === 'video'
	const source = isVideo
		? getVideoRxChannelSource(self, destination.device, destination.channel)
		: getAudioRxChannelSource(self, destination.device, destination.channel)
	if (!source) return { source: '', status: SUBSCRIPTION_STATE_NOT_SUBSCRIBED }

	const device = deviceByIdentifier(self, destination.device)
	const status = isVideo
		? videoSubscriptionStatusLabel(device?.videoRx?.[destination.channel])
		: subscriptionStateValue(device?.audioRx?.[destination.channel]?.subscriptionStatus)
	return { source: `${source.channelName}@${source.deviceName}`, status }
}

/** The variables of every panel used so far. */
export function routerVariableDefinitions(self: DanteInstance): CompanionVariableDefinitions<DanteRouterVariables> {
	const definitions: Record<string, { name: string }> = {}
	for (const key of routerPanels(self)) {
		const prefix = routerVariablePrefix(key)
		const label = key === DEFAULT_PANEL ? 'Router' : `Router panel ${key}`
		for (const [suffix, name] of Object.entries(ROUTER_PANEL_VARIABLE_NAMES)) {
			definitions[`${prefix}${suffix}`] = { name: `${label}: ${name}` }
		}
	}
	return definitions as CompanionVariableDefinitions<DanteRouterVariables>
}

function panelValues(self: DanteInstance, state: Readonly<RouterState>): RouterPanelVariables {
	const { destination, pending } = state
	const subscription = destination ? destinationSubscription(self, destination) : { source: '', status: '' }
	return {
		destination_device: destination?.device ?? '',
		destination_channel: destination ? String(destination.channel) : '',
		destination_label: destination ? channelLabel(self, destination, 'rx') : '',
		destination_source: subscription.source,
		destination_status: subscription.status,
		pending_device: pending?.device ?? '',
		pending_channel: pending ? String(pending.channel) : '',
		pending_label: pending ? channelLabel(self, pending, 'tx') : '',
	}
}

/** One panel's variable values, under its own prefix. */
function routerPanelVariableValues(self: DanteInstance, panelKey: string): Partial<DanteRouterVariables> {
	const values: Record<string, string> = {}
	const prefix = routerVariablePrefix(panelKey)
	for (const [suffix, value] of Object.entries(panelValues(self, peekState(self, panelKey)))) {
		values[`${prefix}${suffix}`] = value
	}
	return values
}

/** The variable values of every panel used so far. */
export function routerVariableValues(self: DanteInstance): Partial<DanteRouterVariables> {
	const values: Partial<DanteRouterVariables> = {}
	for (const key of routerPanels(self)) Object.assign(values, routerPanelVariableValues(self, key))
	return values
}

const PANEL_FIELD = {
	type: 'textinput' as const,
	label: 'Panel',
	id: 'panel' as const,
	default: '',
	useVariables: true,
	tooltip:
		'Buttons with the same Panel share one selection. Leave empty to use the connection-wide panel; ' +
		'give each operator their own name, or use $(this:page) for one panel per page, to keep their ' +
		'selections apart. Use the same Panel in the Router actions and the Router feedbacks of a button.',
}

function destinationFields(self: DanteInstance) {
	return [
		PANEL_FIELD,
		channelTypeOption('channelType'),
		{
			type: 'dropdown' as const,
			label: 'Destination Device',
			id: 'destinationDevice' as const,
			choices: rxDeviceChoices(self),
			default: firstChoiceId(rxDeviceChoices(self), ''),
			disableAutoExpression: true,
			allowCustom: true,
		},
		...perDeviceChannelFields<keyof DestinationOptions>(
			self,
			'destinationDevice',
			'destinationChannel',
			'rx',
			'Destination channel',
		),
		...perDeviceMissingChannelWarnings(self, 'destinationDevice', 'rx'),
	]
}

function sourceFields(self: DanteInstance) {
	return [
		PANEL_FIELD,
		channelTypeOption('channelType'),
		{
			type: 'dropdown' as const,
			label: 'Source Device',
			id: 'sourceDevice' as const,
			choices: txDeviceChoices(self),
			default: firstChoiceId(txDeviceChoices(self), ''),
			disableAutoExpression: true,
			allowCustom: true,
		},
		...perDeviceChannelFields<keyof SourceOptions>(self, 'sourceDevice', 'sourceChannel', 'tx', 'Source channel'),
		...perDeviceMissingChannelWarnings(self, 'sourceDevice', 'tx'),
	]
}

const SOURCE_MODE_CHOICES: DropdownChoice<RouterSourceMode>[] = [
	{ id: 'route', label: 'Route to the selected destination now' },
	{ id: 'preselect', label: 'Preselect, route on Take' },
]

export function routerActions(self: DanteInstance): CompanionActionDefinitions<RouterActionSchema> {
	return {
		router_select_destination: {
			name: 'Router - Select Destination',
			description: 'Selects the destination the next source press (or Take) routes to',
			options: destinationFields(self),
			callback: (action) => {
				const destination = destinationFromOptions(self, action.options)
				if (!destination) throw new DanteCommandError('Router: no destination channel chosen')
				const state = routerState(self, action.options.panel)
				state.destination = destination
				// a source preselected for another destination must not follow the selection
				state.pending = undefined
				selectionChanged(self, action.options.panel)
			},
		},
		router_select_source: {
			name: 'Router - Select Source',
			description: 'Routes this source to the selected destination, or preselects it for Take',
			options: [
				...sourceFields(self),
				{
					type: 'dropdown',
					label: 'Mode',
					id: 'mode',
					choices: SOURCE_MODE_CHOICES,
					default: 'route',
					disableAutoExpression: true,
				},
			],
			callback: async (action, context) => {
				const source = sourceFromOptions(self, action.options)
				if (!source) throw new DanteCommandError('Router: no source channel chosen')
				const panel = action.options.panel
				const state = routerState(self, panel)
				if (action.options.mode === 'preselect') {
					state.pending = source
					selectionChanged(self, panel)
					return
				}
				state.pending = undefined
				selectionChanged(self, panel)
				await routeToDestination(self, state, source, context.signal)
			},
		},
		router_take: {
			name: 'Router - Take',
			description: 'Routes the preselected source to the selected destination',
			options: [PANEL_FIELD],
			callback: async (action, context) => {
				const state = routerState(self, action.options.panel)
				if (!state.pending) throw new DanteCommandError('Router: no source preselected')
				await routeToDestination(self, state, state.pending, context.signal)
				state.pending = undefined
				selectionChanged(self, action.options.panel)
			},
		},
		router_clear_destination: {
			name: 'Router - Clear Destination',
			description: 'Unsubscribes the selected destination',
			options: [PANEL_FIELD],
			callback: async (action, context) => {
				const destination = peekState(self, action.options.panel).destination
				if (!destination) throw new DanteCommandError('Router: no destination selected')
				const clear =
					destination.channelType === 'video' ? clearVideoCrosspointConfirmed : clearAudioCrosspointConfirmed
				await clear(self, destination.device, destination.channel, { signal: context.signal })
			},
		},
		router_cancel: {
			name: 'Router - Cancel',
			description: 'Drops the source waiting for Take',
			options: [PANEL_FIELD],
			callback: (action) => {
				routerState(self, action.options.panel).pending = undefined
				selectionChanged(self, action.options.panel)
			},
		},
	}
}

export function routerFeedbacks(self: DanteInstance): CompanionFeedbackDefinitions<RouterFeedbackSchema> {
	return {
		router_destination_selected: {
			type: 'boolean',
			name: 'Router - Destination Selected',
			description: 'True when this destination is the selected one',
			defaultStyle: { color: combineRgb(0, 0, 0), bgcolor: combineRgb(255, 255, 0) },
			options: destinationFields(self),
			callback: (feedback) =>
				sameChannel(
					destinationFromOptions(self, feedback.options),
					feedbackState(self, feedback.options.panel).destination,
				),
		},
		router_source_routed: {
			type: 'boolean',
			name: 'Router - Source Routed to Selected Destination',
			description: 'True when the selected destination is subscribed to this source, and the subscription works',
			defaultStyle: { color: combineRgb(0, 0, 0), bgcolor: combineRgb(0, 204, 0) },
			options: sourceFields(self),
			unsubscribe: (feedback) => untrackFeedback(self, feedback.id),
			callback: (feedback) => {
				const destination = feedbackState(self, feedback.options.panel).destination
				const source = sourceFromOptions(self, feedback.options)
				// re-checked when either device reports a change; a selection change re-checks every one
				trackFeedbackDevices(
					self,
					feedback.id,
					destination
						? [resolveDeviceIp(self, destination.device), resolveDeviceIp(self, feedback.options.sourceDevice)]
						: [],
				)
				if (!destination || !source || destination.channelType !== source.channelType) return false
				return crosspointConnectedByNumber(
					self,
					destination.channelType,
					destination.device,
					destination.channel,
					source.device,
					source.channel,
				)
			},
		},
		router_source_pending: {
			type: 'boolean',
			name: 'Router - Source Preselected',
			description: 'True when this source is waiting for Take',
			defaultStyle: { color: combineRgb(0, 0, 0), bgcolor: combineRgb(255, 128, 0) },
			options: sourceFields(self),
			callback: (feedback) =>
				sameChannel(sourceFromOptions(self, feedback.options), feedbackState(self, feedback.options.panel).pending),
		},
		router_take_armed: {
			type: 'boolean',
			name: 'Router - Take Armed',
			description: 'True when a destination is selected and a source is waiting for Take',
			defaultStyle: { color: combineRgb(255, 255, 255), bgcolor: combineRgb(255, 0, 0) },
			options: [PANEL_FIELD],
			callback: (feedback) => {
				const { destination, pending } = feedbackState(self, feedback.options.panel)
				return destination !== undefined && pending !== undefined
			},
		},
	}
}

// ---------------------------------------------------------------- presets

const BLACK = combineRgb(0, 0, 0)
const WHITE = combineRgb(255, 255, 255)
const DARK_GREY = combineRgb(40, 40, 40)

type Presets = CompanionPresetDefinitions<DanteModuleTypes>
type Group = CompanionPresetGroup<DanteModuleTypes>
type PresetFeedbacks = Extract<NonNullable<Presets[string]>, { type: 'simple' }>['feedbacks']

/** Option values naming one channel of one device, under the per-device key the dropdowns use. */
function channelOptions(
	deviceKey: 'destinationDevice' | 'sourceDevice',
	base: 'destinationChannel' | 'sourceChannel',
	channelType: ChannelMediaType,
	device: string,
	channel: number,
): Record<string, string | number> {
	return {
		panel: DEFAULT_PANEL,
		channelType,
		[deviceKey]: device,
		[`${channelOptionPrefix(base, channelType)}_${sanitiseVariableId(device)}`]: channel,
	}
}

function channelChoices(
	self: DanteInstance,
	direction: 'rx' | 'tx',
	channelType: ChannelMediaType,
	device: DeviceName,
): DropdownChoice<ChannelNumber>[] {
	const isVideo = channelType === 'video'
	const byDevice =
		direction === 'rx'
			? isVideo
				? self.videoRxChannelsChoices
				: self.rxChannelsChoices
			: isVideo
				? self.videoTxChannelsChoices
				: self.txChannelsChoices
	return byDevice?.[device] ?? []
}

function presetText(device: string, label: string): string {
	return `${device}\\n${label}`
}

/** The router presets, built from the devices currently known. */
export function routerPresets(self: DanteInstance): {
	sections: CompanionPresetSection<DanteModuleTypes>[]
	presets: Presets
} {
	const presets: Presets = {}
	const destinationGroups: Group[] = []
	const takeSourceGroups: Group[] = []
	const directSourceGroups: Group[] = []

	presets.router_take = {
		type: 'simple',
		name: 'Take',
		style: { text: 'TAKE\\n$(dante:router_pending_label)', size: 'auto', color: WHITE, bgcolor: DARK_GREY },
		steps: [{ down: [{ actionId: 'router_take', options: { panel: DEFAULT_PANEL } }], up: [] }],
		feedbacks: [
			{
				feedbackId: 'router_take_armed',
				options: { panel: DEFAULT_PANEL },
				style: { bgcolor: combineRgb(255, 0, 0), color: WHITE },
			},
		],
	}
	presets.router_clear = {
		type: 'simple',
		name: 'Clear the selected destination',
		style: { text: 'CLEAR\\nDEST', size: 'auto', color: WHITE, bgcolor: DARK_GREY },
		steps: [{ down: [{ actionId: 'router_clear_destination', options: { panel: DEFAULT_PANEL } }], up: [] }],
		feedbacks: [],
	}
	presets.router_cancel = {
		type: 'simple',
		name: 'Cancel the preselected source',
		style: { text: 'CANCEL', size: 'auto', color: WHITE, bgcolor: DARK_GREY },
		steps: [{ down: [{ actionId: 'router_cancel', options: { panel: DEFAULT_PANEL } }], up: [] }],
		feedbacks: [],
	}
	presets.router_selection = {
		type: 'simple',
		name: 'Selected destination and its source',
		style: {
			text: '$(dante:router_destination_label)\\n$(dante:router_destination_source)',
			size: 'auto',
			color: WHITE,
			bgcolor: BLACK,
		},
		steps: [{ down: [], up: [] }],
		feedbacks: [],
	}

	const presetsFor = routerPresetDeviceFilter(self.config)
	for (const { name } of channelFieldDevices(self)) {
		if (!presetsFor(name)) continue
		const key = sanitiseVariableId(name)
		for (const channelType of CHANNEL_MEDIA_TYPES) {
			const typeSuffix = channelType === 'audio' ? '' : ` (${CHANNEL_MEDIA_TYPE_LABELS[channelType]})`
			const typeKey = channelType === 'audio' ? '' : `_${channelType}`

			const destinationIds: string[] = []
			for (const choice of channelChoices(self, 'rx', channelType, name)) {
				const id = `router_dst${typeKey}_${key}_${choice.id}`
				const options = channelOptions('destinationDevice', 'destinationChannel', channelType, name, choice.id)
				presets[id] = {
					type: 'simple',
					name: `Destination ${name} ${choice.id}`,
					style: {
						text: presetText(name, channelDisplayLabel(choice.label, choice.id)),
						size: 'auto',
						color: WHITE,
						bgcolor: BLACK,
					},
					steps: [
						{ down: [{ actionId: 'router_select_destination', options: options as DestinationOptions }], up: [] },
					],
					feedbacks: [
						{
							feedbackId: 'router_destination_selected',
							options: options as DestinationOptions,
							style: { bgcolor: combineRgb(255, 255, 0), color: BLACK },
						},
					],
				}
				destinationIds.push(id)
			}
			if (destinationIds.length > 0) {
				destinationGroups.push({
					id: `router_dst${typeKey}_${key}`,
					type: 'simple',
					name: `${name}${typeSuffix}`,
					presets: destinationIds,
				})
			}

			for (const mode of ['preselect', 'route'] as const) {
				const sourceIds: string[] = []
				for (const choice of channelChoices(self, 'tx', channelType, name)) {
					const id = `router_src_${mode}${typeKey}_${key}_${choice.id}`
					const options = channelOptions('sourceDevice', 'sourceChannel', channelType, name, choice.id)
					const feedbacks: PresetFeedbacks = [
						{
							feedbackId: 'router_source_routed',
							options: options as SourceOptions,
							style: { bgcolor: combineRgb(0, 204, 0), color: BLACK },
						},
					]
					if (mode === 'preselect') {
						feedbacks.push({
							feedbackId: 'router_source_pending',
							options: options as SourceOptions,
							style: { bgcolor: combineRgb(255, 128, 0), color: BLACK },
						})
					}
					presets[id] = {
						type: 'simple',
						name: `Source ${name} ${choice.id}`,
						style: {
							text: presetText(name, channelDisplayLabel(choice.label, choice.id)),
							size: 'auto',
							color: WHITE,
							bgcolor: BLACK,
						},
						steps: [
							{
								down: [{ actionId: 'router_select_source', options: { ...(options as SourceOptions), mode } }],
								up: [],
							},
						],
						feedbacks,
					}
					sourceIds.push(id)
				}
				if (sourceIds.length > 0) {
					;(mode === 'preselect' ? takeSourceGroups : directSourceGroups).push({
						id: `router_src_${mode}${typeKey}_${key}`,
						type: 'simple',
						name: `${name}${typeSuffix}`,
						presets: sourceIds,
					})
				}
			}
		}
	}

	const sections: CompanionPresetSection<DanteModuleTypes>[] = [
		{
			id: 'router_controls',
			name: 'Router: controls',
			description: 'Take, Clear, Cancel and a display of the selected destination',
			definitions: ['router_take', 'router_clear', 'router_cancel', 'router_selection'],
		},
		{
			id: 'router_destinations',
			name: 'Router: destinations',
			description: 'Selects a destination. Lit while it is the selected one.',
			definitions: destinationGroups,
		},
		{
			id: 'router_sources_take',
			name: 'Router: sources (with Take)',
			description:
				'Preselects a source for the Take button. Green when routed to the selected destination, orange while waiting for Take.',
			definitions: takeSourceGroups,
		},
		{
			id: 'router_sources_direct',
			name: 'Router: sources (route immediately)',
			description: 'Routes a source to the selected destination at once. Green when routed to it.',
			definitions: directSourceGroups,
		},
	]

	return { sections, presets }
}
