import type DanteInstance from './main.js'
import { routerPresets } from './router.js'

/**
 * Builds and registers this instance's preset definitions with Companion. The router panel presets
 * are the only ones, and are generated only when the connection opts into them.
 */
export function UpdatePresetDefinitions(self: DanteInstance): void {
	if (self.config?.routerPresets !== true) {
		self.setPresetDefinitions([], {})
		return
	}
	const { sections, presets } = routerPresets(self)
	self.setPresetDefinitions(sections, presets)
}
