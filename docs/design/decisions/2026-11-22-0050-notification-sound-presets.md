# Notification sound presets vs. arbitrary audio upload

Source: Settings gap audit [#3110](https://github.com/aspectly-labs/Mikka/issues/3110) item D.8 (Frame 07 通知) and [#2957](https://github.com/aspectly-labs/Mikka/issues/2957).

## Context

Figma Frame 07 (通知) includes notification sound selection alongside a custom sound entry. Today Mikka has no binary audio upload pipeline, no user-audio object storage bucket, and system mobile push notifications go through Expo Push Service (`lib/mobile-push-delivery.ts`) to APNs and FCM.

## Platform constraint

APNs (`aps.sound`) and FCM (`android.notification.sound`) only play sound resources statically bundled inside the signed native iOS/Android application binary, `'default'`, or `null` (silent). Neither Expo Push Service nor APNs/FCM accepts arbitrary user-uploaded audio files or remote audio URLs as system notification tones.

## Decision

1. **No server-side custom audio binary upload.** Any custom local audio file playback is purely client-local on Web/Desktop (`localStorage` / Electron local path) and unsupported for mobile system pushes.
2. **Sync preset choice via `SETTINGS_REGISTRY`.** Register personal account setting `notificationSound` (`'default' | 'subtle' | 'chime' | 'none'`, default `'default'`, `page: 'notifications'`, `group: 'notifications'`) in `lib/settings/registry.ts` so Web and Desktop clients share one persisted preset preference.
3. **Honor `'none'` on mobile push.** When `notificationSound` resolves to `'none'`, `lib/mobile-push.ts` marks the outbound phone push silent (`sound: null` in `lib/mobile-push-delivery.ts`); named presets (`'default'`, `'subtle'`, `'chime'`) continue using the OS `'default'` push sound unless bundled into the mobile binary later.
