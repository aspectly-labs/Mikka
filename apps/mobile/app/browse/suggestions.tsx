import SuggestionsScreen from '../(tabs)/suggestions/index'
import { BrowseClose } from '@/features/shell/components/browse-close'

/** 建议 opened from the sidebar trial (the tab is hidden there). */
export default function BrowseSuggestions() {
  return <><BrowseClose /><SuggestionsScreen /></>
}
