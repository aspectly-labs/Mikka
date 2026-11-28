// Positive fixture for no-mode-flags: every mode flag and multi-branch mode switch below should be flagged.

export const isHostedMode = true

export interface BillingPanelProps {
  isCloudMode?: boolean
  surfaceMode?: 'cloud' | 'selfhost'
}

export function renderUpgradeBanner(props: { isSelfHostMode: boolean; hostedMode: boolean }): string {
  const { isSelfHostMode, hostedMode } = props
  return isSelfHostMode && !hostedMode ? 'license' : 'checkout'
}

export function resolveOriginByMode(mode: string): string {
  if (mode === 'cloud') {
    return 'https://app.example.com'
  } else if (mode === 'selfhost') {
    return 'https://self.example.com'
  }
  return 'https://fallback.example.com'
}

export function resolveAuthFlow(deploymentMode: string): string {
  switch (deploymentMode) {
    case 'cloud':
      return 'hosted-oauth'
    case 'community':
      return 'local-oauth'
    default:
      return 'none'
  }
}

export const runtimeFeatureBundle = {
  deploymentModeFlag: true,
}
