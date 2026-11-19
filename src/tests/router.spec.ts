import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DevicesData } from '../api/index.js'
import type DanteInstance from '../main.js'
import { routerPresetDeviceFilter } from '../config.js'
import { UpdatePresetDefinitions } from '../presets.js'
import { UpdateVariableDefinitions } from '../variables.js'
import { routerActions, routerFeedbacks, routerPresets, routerState, routerVariableValues } from '../router.js'

const makeAudioCrosspointConfirmed = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../api/commands.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../api/commands.js')>()),
	makeAudioCrosspointConfirmed,
}))

/** A receiver (Amp, 2 inputs, input 1 subscribed to Out 2@Desk) and a transmitter (Desk, 2 outputs). */
function devicesData(): DevicesData {
	return {
		'10.0.0.5': {
			name: 'Amp',
			ports: { ARC: 4440 },
			audioRx: {
				count: 2,
				1: { number: 1, name: 'Left', sourceDevice: 'Desk', sourceChannel: 'Out 2', subscriptionStatus: 0x0009 },
				2: { number: 2, name: '' },
			},
		},
		'10.0.0.6': {
			name: 'Desk',
			ports: { ARC: 4440 },
			audioTx: { count: 2, 1: { number: 1, name: 'Out 1' }, 2: { number: 2, name: 'Out 2' } },
		},
	} as unknown as DevicesData
}

function mockInstance(createVariables: string[] = [], routerPresets = true) {
	const data = devicesData()
	return {
		config: { createVariables, routerPresets },
		devicesData: data,
		devicesChoices: Object.entries(data).map(([, device]) => ({ id: device.name!, label: device.name! })),
		rxChannelsChoices: {
			Amp: [
				{ id: 1, label: 'Left' },
				{ id: 2, label: '' },
			],
		},
		txChannelsChoices: {
			Desk: [
				{ id: 1, label: 'Out 1' },
				{ id: 2, label: 'Out 2' },
			],
		},
		videoRxChannelsChoices: {},
		videoTxChannelsChoices: {},
		checkFeedbacks: vi.fn(),
		setVariableValues: vi.fn(),
		setVariableDefinitions: vi.fn(),
		setPresetDefinitions: vi.fn(),
		log: vi.fn(),
	} as unknown as DanteInstance
}

const destination = (channel: number) => ({
	channelType: 'audio' as const,
	destinationDevice: 'Amp',
	destinationChannel_Amp: channel,
})
const source = (channel: number, mode: 'route' | 'preselect' = 'route') => ({
	channelType: 'audio' as const,
	sourceDevice: 'Desk',
	sourceChannel_Desk: channel,
	mode,
})

const context = { signal: undefined } as never

async function run(self: DanteInstance, actionId: string, options: object = {}): Promise<void> {
	const actions = routerActions(self) as any
	await actions[actionId].callback({ options }, context)
}

function feedback(self: DanteInstance, feedbackId: string, options: object = {}): boolean {
	const feedbacks = routerFeedbacks(self) as any
	return feedbacks[feedbackId].callback({ id: 'fb', options })
}

describe('router panel', () => {
	let self: DanteInstance
	beforeEach(() => {
		self = mockInstance()
		makeAudioCrosspointConfirmed.mockClear()
	})

	it('selects a destination, and only that one reads as selected', async () => {
		await run(self, 'router_select_destination', destination(1))

		expect(routerState(self).destination).toEqual({ channelType: 'audio', device: 'Amp', channel: 1 })
		expect(feedback(self, 'router_destination_selected', destination(1))).toBe(true)
		expect(feedback(self, 'router_destination_selected', destination(2))).toBe(false)
		expect(self.checkFeedbacks).toHaveBeenCalled()
	})

	it('routes a source to the selected destination at once in route mode', async () => {
		await run(self, 'router_select_destination', destination(2))
		await run(self, 'router_select_source', source(1))

		expect(makeAudioCrosspointConfirmed).toHaveBeenCalledWith(self, 'Amp', 'Out 1', 'Desk', 2, { signal: undefined })
	})

	it('refuses a source press with no destination selected', async () => {
		await expect(run(self, 'router_select_source', source(1))).rejects.toThrow(/no destination selected/)
		expect(makeAudioCrosspointConfirmed).not.toHaveBeenCalled()
	})

	it('waits for Take in preselect mode, then routes and drops the preselection', async () => {
		await run(self, 'router_select_destination', destination(2))
		await run(self, 'router_select_source', source(1, 'preselect'))

		expect(makeAudioCrosspointConfirmed).not.toHaveBeenCalled()
		expect(feedback(self, 'router_source_pending', source(1))).toBe(true)
		expect(feedback(self, 'router_take_armed')).toBe(true)

		await run(self, 'router_take')

		expect(makeAudioCrosspointConfirmed).toHaveBeenCalledWith(self, 'Amp', 'Out 1', 'Desk', 2, { signal: undefined })
		expect(routerState(self).pending).toBeUndefined()
		expect(feedback(self, 'router_take_armed')).toBe(false)
	})

	it('keeps the preselection when Take fails, so it can be retried', async () => {
		makeAudioCrosspointConfirmed.mockRejectedValueOnce(new Error('device offline'))
		await run(self, 'router_select_destination', destination(2))
		await run(self, 'router_select_source', source(1, 'preselect'))

		await expect(run(self, 'router_take')).rejects.toThrow('device offline')
		expect(routerState(self).pending).toEqual({ channelType: 'audio', device: 'Desk', channel: 1 })
	})

	it('drops a preselected source when another destination is selected, and on Cancel', async () => {
		await run(self, 'router_select_destination', destination(1))
		await run(self, 'router_select_source', source(1, 'preselect'))
		await run(self, 'router_select_destination', destination(2))
		expect(routerState(self).pending).toBeUndefined()

		await run(self, 'router_select_source', source(2, 'preselect'))
		await run(self, 'router_cancel')
		expect(routerState(self).pending).toBeUndefined()
		expect(routerState(self).destination?.channel).toBe(2)
	})

	it('lights the source the selected destination is subscribed to', async () => {
		await run(self, 'router_select_destination', destination(1))

		expect(feedback(self, 'router_source_routed', source(2))).toBe(true)
		expect(feedback(self, 'router_source_routed', source(1))).toBe(false)
	})

	it('lights no source while no destination is selected', () => {
		expect(feedback(self, 'router_source_routed', source(2))).toBe(false)
	})

	it('describes the selection in its variables', async () => {
		await run(self, 'router_select_destination', destination(1))
		await run(self, 'router_select_source', source(1, 'preselect'))

		expect(routerVariableValues(self)).toEqual({
			router_destination_device: 'Amp',
			router_destination_channel: '1',
			router_destination_label: 'Left',
			router_destination_source: 'Out 2@Desk',
			router_destination_status: 'connected',
			router_pending_device: 'Desk',
			router_pending_channel: '1',
			router_pending_label: 'Out 1',
		})
	})

	it('labels an unnamed destination channel by number', async () => {
		await run(self, 'router_select_destination', destination(2))
		expect(routerVariableValues(self).router_destination_label).toBe('Ch 2')
		expect(routerVariableValues(self).router_destination_status).toBe('not subscribed')
	})

	it('defines no router variables until a router button is used', async () => {
		UpdateVariableDefinitions(self)
		expect(self.setVariableDefinitions).not.toHaveBeenCalledWith(
			expect.objectContaining({ router_destination_label: expect.anything() }),
		)

		await run(self, 'router_select_destination', destination(1))
		expect(self.setVariableDefinitions).toHaveBeenCalledWith(
			expect.objectContaining({ router_destination_label: expect.anything() }),
		)
		expect(self.setVariableValues).toHaveBeenCalledWith(expect.objectContaining({ router_destination_label: 'Left' }))
	})
})

describe('router panels', () => {
	let self: DanteInstance
	beforeEach(() => {
		self = mockInstance()
		makeAudioCrosspointConfirmed.mockClear()
	})

	it('keeps a separate selection per panel', async () => {
		await run(self, 'router_select_destination', { ...destination(1), panel: 'A' })
		await run(self, 'router_select_destination', { ...destination(2), panel: 'B' })

		expect(feedback(self, 'router_destination_selected', { ...destination(1), panel: 'A' })).toBe(true)
		expect(feedback(self, 'router_destination_selected', { ...destination(1), panel: 'B' })).toBe(false)
		expect(feedback(self, 'router_destination_selected', { ...destination(2), panel: 'B' })).toBe(true)
		expect(routerState(self).destination).toBeUndefined()
	})

	it("routes a source to its own panel's destination, and Take only takes its own panel's source", async () => {
		await run(self, 'router_select_destination', { ...destination(1), panel: 'A' })
		await run(self, 'router_select_destination', { ...destination(2), panel: 'B' })
		await run(self, 'router_select_source', { ...source(1), panel: 'B' })
		expect(makeAudioCrosspointConfirmed).toHaveBeenCalledWith(self, 'Amp', 'Out 1', 'Desk', 2, { signal: undefined })

		await run(self, 'router_select_source', { ...source(2, 'preselect'), panel: 'A' })
		expect(feedback(self, 'router_take_armed', { panel: 'A' })).toBe(true)
		expect(feedback(self, 'router_take_armed', { panel: 'B' })).toBe(false)
		await expect(run(self, 'router_take', { panel: 'B' })).rejects.toThrow(/no source preselected/)
	})

	it('treats an empty, blank or missing Panel as the shared panel, and trims names', async () => {
		await run(self, 'router_select_destination', { ...destination(1), panel: '  ' })
		expect(feedback(self, 'router_destination_selected', destination(1))).toBe(true)

		await run(self, 'router_select_destination', { ...destination(2), panel: ' 3 ' })
		expect(feedback(self, 'router_destination_selected', { ...destination(2), panel: '3' })).toBe(true)
	})

	it("publishes a named panel's variables under its own prefix, defining them on first use", async () => {
		UpdateVariableDefinitions(self)
		vi.mocked(self.setVariableDefinitions).mockClear()

		await run(self, 'router_select_destination', { ...destination(1), panel: 'Op 2' })

		expect(self.setVariableDefinitions).toHaveBeenCalledWith(
			expect.objectContaining({ router_panel_Op_2_destination_label: expect.anything() }),
		)
		expect(self.setVariableValues).toHaveBeenCalledWith(
			expect.objectContaining({ router_panel_Op_2_destination_label: 'Left' }),
		)
		expect(routerVariableValues(self)).toMatchObject({ router_panel_Op_2_destination_label: 'Left' })
		expect(routerVariableValues(self)).not.toHaveProperty('router_destination_label')

		vi.mocked(self.setVariableDefinitions).mockClear()
		await run(self, 'router_select_destination', { ...destination(2), panel: 'Op 2' })
		expect(self.setVariableDefinitions).not.toHaveBeenCalled()
	})

	it("defines a named panel's variables when one of its feedbacks is first drawn, once", () => {
		UpdateVariableDefinitions(self)
		vi.mocked(self.setVariableDefinitions).mockClear()

		expect(feedback(self, 'router_take_armed', { panel: 'Op3' })).toBe(false)
		expect(self.setVariableDefinitions).toHaveBeenCalledWith(
			expect.objectContaining({ router_panel_Op3_destination_label: expect.anything() }),
		)
		expect(self.setVariableValues).toHaveBeenCalledWith(
			expect.objectContaining({ router_panel_Op3_destination_label: '' }),
		)

		vi.mocked(self.setVariableDefinitions).mockClear()
		feedback(self, 'router_destination_selected', { ...destination(1), panel: 'Op3' })
		expect(self.setVariableDefinitions).not.toHaveBeenCalled()
	})
})

describe('router preset device filter', () => {
	const filter = (routerPresetsFilter: string, routerPresetsDevices: unknown) =>
		routerPresetDeviceFilter({ routerPresetsFilter, routerPresetsDevices } as never)

	it('keeps every device by default, or when the setting is missing or unknown', () => {
		expect(routerPresetDeviceFilter(undefined)('Amp')).toBe(true)
		expect(filter('all', 'Amp')('Amp')).toBe(true)
		expect(filter('bogus', 'Amp')('Amp')).toBe(true)
	})

	it('excludes the listed devices, matching whole names case-insensitively', () => {
		const keep = filter('exclude', ' amp , Stage Box;Desk')
		expect(keep('Amp')).toBe(false)
		expect(keep('Stage Box')).toBe(false)
		expect(keep('Desk')).toBe(false)
		expect(keep('Amp-2')).toBe(true)
	})

	it('includes only the listed devices, and none when the list is empty', () => {
		const keep = filter('include', 'Amp')
		expect(keep('Amp')).toBe(true)
		expect(keep('Desk')).toBe(false)
		expect(filter('include', '')('Amp')).toBe(false)
		expect(filter('include', undefined)('Amp')).toBe(false)
	})

	it('reads * as any run of characters, and every other character literally', () => {
		const keep = filter('include', 'MXN5-*, Rack (1).A')
		expect(keep('MXN5-C-ESCBxl10')).toBe(true)
		expect(keep('mxn5-')).toBe(true)
		expect(keep('AVIOUSB-MXN5-')).toBe(false)
		expect(keep('Rack (1).A')).toBe(true)
		expect(keep('Rack (1)xA')).toBe(false)
	})

	it('leaves the filtered-out devices out of the presets, but keeps the controls', () => {
		const self = mockInstance()
		self.config = { ...self.config, routerPresetsFilter: 'exclude', routerPresetsDevices: 'Desk' }
		const { sections, presets } = routerPresets(self)

		const ids = Object.keys(presets)
		expect(ids.filter((id) => id.startsWith('router_dst_'))).toEqual(['router_dst_Amp_1', 'router_dst_Amp_2'])
		expect(ids.filter((id) => id.startsWith('router_src_'))).toEqual([])
		expect(sections[0].definitions).toContain('router_take')
	})
})

describe('router presets option', () => {
	it('registers no presets unless the connection opts in', () => {
		const off = mockInstance(['router'], false)
		UpdatePresetDefinitions(off)
		expect(off.setPresetDefinitions).toHaveBeenCalledWith([], {})

		const on = mockInstance(['router'], true)
		UpdatePresetDefinitions(on)
		const [sections] = vi.mocked(on.setPresetDefinitions).mock.calls[0]
		expect(sections).toHaveLength(4)
	})
})

describe('router presets', () => {
	it('offers one destination per receive channel and one source per transmit channel and mode', () => {
		const { sections, presets } = routerPresets(mockInstance())

		expect(sections.map((section) => section.id)).toEqual([
			'router_controls',
			'router_destinations',
			'router_sources_take',
			'router_sources_direct',
		])
		const ids = Object.keys(presets)
		expect(ids.filter((id) => id.startsWith('router_dst_'))).toEqual(['router_dst_Amp_1', 'router_dst_Amp_2'])
		expect(ids.filter((id) => id.startsWith('router_src_preselect_'))).toHaveLength(2)
		expect(ids.filter((id) => id.startsWith('router_src_route_'))).toHaveLength(2)
	})

	it('stores the channel under the per-device option key the dropdowns read', () => {
		const { presets } = routerPresets(mockInstance())
		const preset = presets['router_src_preselect_Desk_2'] as {
			steps: { down: { actionId: string; options: Record<string, unknown> }[] }[]
		}

		expect(preset.steps[0].down[0]).toEqual({
			actionId: 'router_select_source',
			options: { panel: '', channelType: 'audio', sourceDevice: 'Desk', sourceChannel_Desk: 2, mode: 'preselect' },
		})
	})

	it('groups each device under its own name, and every group refers to existing presets', () => {
		const { sections, presets } = routerPresets(mockInstance())
		for (const section of sections.slice(1)) {
			for (const group of section.definitions) {
				if (typeof group === 'string' || group.type !== 'simple') continue
				for (const id of group.presets) expect(presets[id]).toBeDefined()
			}
		}
		const destinations = sections[1].definitions as { name: string }[]
		expect(destinations.map((group) => group.name)).toEqual(['Amp'])
	})
})
