'use client'

import { useEffect, useState, type FormEvent } from 'react'
import useSWR from 'swr'
import { SquareTerminal } from '@/components/icons'
import { pollDevices, type DeviceView } from '@/app/actions/agents'
import { CodeBlock, CodeBlockCopyButton, CodeBlockHeader, CodeBlockTitle } from '@/components/reui/code-block/code-block'
import { IconTile } from '@/components/reui/icon-tile'
import type { SettingsDevicesProps } from '@/components/slots/settings-devices-contract'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { goToHref } from '@/components/workspace/workspace-navigation'
import { useLiveKey } from '@/hooks/use-live-key'
import { daemonCommands } from '@/lib/daemon-commands'
import { DEVICE_NAME_MAX } from '@/lib/device-name'
import { useTranslations } from '@/lib/intl/i18n-client'
import { listReadDeadline, listReadPresence, observeListRead, ownerListWorkspace, UNRESOLVED_LIST_SCOPE } from '@/lib/live/list-read'
import { daemonPackageName, desktopReleasesUrl } from '@/lib/platform/client-config'
import { bridgeFromWindow, type MikkaWindow } from '@/lib/platform/detect'
import { publicServiceAddress } from '@/lib/platform/public-origin'
import { usePlatform } from '@/lib/platform/use-platform'
import { DEVICE_MIGRATION_CAPABILITY } from '@/lib/settings/device-policy-contract'
import { useActionError } from '@/lib/use-action-error'
import { DevicesPage } from '@ui-slot/settings-devices'
import { ConnectDeviceDialog } from './connect-device-dialog'
import { DeviceDetailView } from './device-detail-view'
import { LocalSetupStatus } from './local-setup-status'
import { SshAddDialog } from './ssh-add-dialog'

function readDeviceParam(): string | null {
  if (typeof window === 'undefined') return null
  const value = new URL(window.location.href).searchParams.get('device')
  return value && value.length <= 80 ? value : null
}

type HostedDevicesPageProps = SettingsDevicesProps & {
  onSelect?: (device: DeviceView) => void
  migrationAvailable?: boolean
}

/**
 * 设置 › 设备 (Figma 1508:2 Frame 15 + Frames 44–46):
 * - Frame 15: paired devices card (clicking a row opens inline DeviceDetailView),
 *   `+` pairing dialog (`name <= 60`), and bottom mobile-thread switches honestly
 *   marking cross-device migration `· 待接入` where `migration.available === false`.
 * - Frames 44–46: inline DeviceDetailView with content-column `‹ 设备` back button.
 */
export function DevicesSettings({ workspaceId }: { workspaceId?: string }) {
  const key = 'devices-settings'
  const { data, error, mutate } = useSWR(key, () => observeListRead(pollDevices))
  const devices = error ? undefined : data?.devices
  const owner = data?.live.ownerId
  const home = owner ? ownerListWorkspace(data, owner) : null
  useLiveKey('device_list', home ?? UNRESOLVED_LIST_SCOPE, [key], home, {
    minIntervalMs: 2_000,
    deadline: owner ? listReadDeadline(data, owner) : undefined,
    presence: listReadPresence(data),
    shareAcrossTabs: true,
  })

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [desktopSsh, setDesktopSsh] = useState(false)
  const [thisDevice, setThisDevice] = useState<string | null>(null)

  useEffect(() => {
    const syncLocation = () => setSelectedId(readDeviceParam())
    syncLocation()
    window.addEventListener('popstate', syncLocation)
    return () => window.removeEventListener('popstate', syncLocation)
  }, [])

  useEffect(() => {
    const bridge = bridgeFromWindow(window as MikkaWindow)
    setDesktopSsh(Boolean(bridge?.ssh))
    void bridge?.device?.status().then(status => setThisDevice(status.deviceId), () => {})
  }, [])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n' && !event.shiftKey && !event.altKey) {
        event.preventDefault()
        setAdding(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function selectDevice(deviceId: string | null) {
    setSelectedId(deviceId)
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (deviceId) url.searchParams.set('device', deviceId)
    else url.searchParams.delete('device')
    goToHref(`${url.pathname}${url.search}${url.hash}`)
  }

  const changed = () => { void mutate() }

  const reconnect = (device: DeviceView) => {
    const ssh = bridgeFromWindow(window as MikkaWindow)?.ssh
    if (!ssh) {
      setReconnecting(true)
      return
    }
    if (device.id === thisDevice && ssh.restartLocal) void ssh.restartLocal().catch(() => {})
    setAdding(true)
  }

  const selectedDevice = selectedId && devices ? devices.find(item => item.id === selectedId) ?? null : null

  const pageProps: HostedDevicesPageProps = {
    devices,
    listError: Boolean(error),
    onAdd: () => setAdding(true),
    onChanged: changed,
    onReconnect: reconnect,
    localSetup: desktopSsh ? <LocalSetupStatus onOnline={changed} /> : null,
    onSelect: device => selectDevice(device.id),
    migrationAvailable: DEVICE_MIGRATION_CAPABILITY.available,
  }

  return (
    <>
      {selectedDevice ? (
        <DeviceDetailView
          device={selectedDevice}
          workspaceId={workspaceId}
          onBack={() => selectDevice(null)}
          onChanged={changed}
          onReconnect={reconnect}
        />
      ) : (
        <DevicesPage {...(pageProps as SettingsDevicesProps)} />
      )}

      {desktopSsh ? (
        <SshAddDialog open={adding} onOpenChange={setAdding} devices={devices ?? []} onAdded={changed} />
      ) : adding ? (
        <PairDeviceDialog open={adding} onOpenChange={next => { setAdding(next); if (!next) changed() }} />
      ) : null}
      {!desktopSsh ? <ConnectDeviceDialog open={reconnecting} onOpenChange={setReconnecting} hideTrigger reconnect /> : null}
    </>
  )
}

function PairDeviceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('Settings.devicesDetail')
  const tConnect = useTranslations('Devices.connect')
  const common = useTranslations('Common')
  const platform = usePlatform()
  const translateError = useActionError()

  const [name, setName] = useState('')
  const [minting, setMinting] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [commands, setCommands] = useState<ReturnType<typeof daemonCommands> | null>(null)

  useEffect(() => {
    if (!open) {
      setName('')
      setToken(null)
      setError('')
      return
    }
    try {
      setCommands(daemonCommands({ ...publicServiceAddress(), packageName: daemonPackageName() }))
    } catch {
      setCommands(null)
    }
  }, [open])

  async function mintToken(event: FormEvent) {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > DEVICE_NAME_MAX || minting) return
    setMinting(true)
    setError('')
    try {
      const agents = await import('@/app/actions/agents')
      const result = await agents.createDeviceToken({ name: trimmed })
      setMinting(false)
      if (result.error !== undefined) {
        setError(translateError(result.error))
        return
      }
      setToken(result.token)
    } catch {
      setMinting(false)
      setError(translateError('deviceSaveFailed'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={common('close')} className="sm:max-w-xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconTile variant="frame" size="sm" aria-hidden="true"><SquareTerminal /></IconTile>
            {tConnect('title')}
          </DialogTitle>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-4">
          <form className="flex flex-col gap-2" onSubmit={event => { void mintToken(event) }}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="pair-device-name">{t('pairDeviceNameLabel')}</FieldLabel>
                <div className="flex items-center gap-2">
                  <Input
                    id="pair-device-name"
                    className="h-(--control-sm) min-w-0 flex-1"
                    maxLength={DEVICE_NAME_MAX}
                    disabled={minting}
                    placeholder={t('pairDeviceNamePlaceholder')}
                    value={name}
                    onChange={event => { setName(event.target.value); setError('') }}
                  />
                  <Button type="submit" variant="secondary" size="sm" disabled={minting || !name.trim() || name.trim().length > DEVICE_NAME_MAX}>
                    {tConnect('generateToken')}
                  </Button>
                </div>
              </Field>
            </FieldGroup>
            {error ? <FieldError role="alert">{error}</FieldError> : null}
          </form>

          {token ? (
            <CodeBlock code={token} language="bash" defaultWrap className="border-0 bg-muted [--code-block-bg:var(--muted)]">
              <CodeBlockHeader className="border-b-0">
                <CodeBlockTitle>{tConnect('tokenOnce')}</CodeBlockTitle>
                <CodeBlockCopyButton className="ml-auto" labels={{ copy: tConnect('copyCommand'), copied: tConnect('copied') }} />
              </CodeBlockHeader>
            </CodeBlock>
          ) : null}

          {commands ? (
            <div className="flex min-w-0 flex-col gap-4">
              {(['install', 'login', 'start'] as const).map(cmdKey => (
                <CodeBlock key={cmdKey} code={commands[cmdKey]} language="bash" defaultWrap className="border-0 bg-muted [--code-block-bg:var(--muted)]">
                  <CodeBlockHeader className="border-b-0">
                    <CodeBlockTitle>{tConnect(`commands.${cmdKey}`)}</CodeBlockTitle>
                    <CodeBlockCopyButton className="ml-auto" labels={{ copy: tConnect('copyCommand'), copied: tConnect('copied') }} />
                  </CodeBlockHeader>
                </CodeBlock>
              ))}
              <p className="text-xs text-muted-foreground">{tConnect('requirements')}</p>
              {platform.runtime === 'web' ? (
                <a className="text-xs font-medium text-muted-foreground underline underline-offset-4" href={desktopReleasesUrl()} target="_blank" rel="noreferrer">
                  {tConnect('desktopLink')}
                </a>
              ) : null}
            </div>
          ) : (
            <FieldError>{tConnect('configurationFailed')}</FieldError>
          )}
        </div>

        <DialogFooter>
          <Button type="button" size="sm" onClick={() => onOpenChange(false)}>
            {tConnect('done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
