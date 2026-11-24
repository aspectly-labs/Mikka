import { SearchScreen } from '@/features/search/screens/search-screen'
import { BrowseClose } from '@/features/shell/components/browse-close'

/** 搜索 opened from the sidebar trial (the tab is hidden there). */
export default function BrowseSearch() {
  return <><BrowseClose /><SearchScreen /></>
}
