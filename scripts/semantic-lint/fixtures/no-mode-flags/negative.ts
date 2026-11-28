// Negative fixture for no-mode-flags: compliant capability checks, device placement, schema validation, and non-deployment modes.

export interface CapabilitySummary {
  readonly canUseSso: boolean
  readonly canManageOrgBilling: boolean
}

export function resolveAuthSummary(capabilities: CapabilitySummary): string {
  if (capabilities.canUseSso) return 'enterprise-sso'
  return capabilities.canManageOrgBilling ? 'cloud-billing' : 'standard'
}

export function describeExecutionPlacement(device: { kind: 'cloud' | 'local'; name: string }): string {
  return device.kind === 'cloud' ? 'Sandbox' : device.name
}

export function isValidDiscoveryEdition(edition: unknown): edition is 'cloud' | 'community' {
  return edition === 'cloud' || edition === 'community'
}

export function resolveEditorKeymap(editorMode: 'insert' | 'normal' | 'visual'): string {
  switch (editorMode) {
    case 'insert':
      return 'typing'
    case 'visual':
      return 'selection'
    default:
      return 'navigation'
  }
}
