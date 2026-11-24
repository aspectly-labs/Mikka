import { Path, Svg } from 'react-native-svg'
import { colors } from '@/lib/theme'

// Canonical Mikka geometric ribbon M (Figma 12Yn4bNPchBdDvdIb83KER, docs/design/brand.md).
export const MIKKA_MARK_PATH = 'M3 6H9V12L3 18V6ZM9 12L15 6H21V18L15 12L9 18V12Z'

export function MikkaMark() {
  return (
    <Svg width={56} height={56} viewBox="0 0 24 24" fill="none" accessible={false}>
      <Path d={MIKKA_MARK_PATH} fill={colors.text} />
    </Svg>
  )
}
