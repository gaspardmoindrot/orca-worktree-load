// Entry bundled by tools/shoot.mjs for the README and catalog images: the real view, fed with
// invented sample data (tools/sample-data.json).
import type { Snapshot } from '../src/model'
import { buildView, CSS, render, type UiState } from '../src/view'

export function panelHtml(snapshot: Snapshot, state: Partial<UiState>, theme: 'dark' | 'light', tokens: Record<string, string>): string {
  const ui: UiState = { open: new Set(), showGone: false, showIdle: false, busy: null, notice: null, ...state }
  const vars = Object.entries(tokens).map(([k, v]) => `--orca-${k}:${v}`).join(';')
  return `<!doctype html><html class="${theme}" style="${vars}"><head><meta charset="utf-8"><style>${CSS}</style></head><body><main>${render(buildView(snapshot), ui)}</main></body></html>`
}
