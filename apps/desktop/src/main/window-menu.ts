/** The native shortcut/action used to open another authenticated Mikka window. */
export interface NewWindowMenuItem {
  label: string
  accelerator: string
  click(): void
}

export interface DesktopMenuCopy {
  file: string
  edit: string
  view: string
  window: string
  newWindow: string
  reload: string
}

export function menuCopy(locale: string): DesktopMenuCopy {
  return locale.toLowerCase().startsWith('zh')
    ? {
      file: '文件',
      edit: '编辑',
      view: '视图',
      window: '窗口',
      newWindow: '新建窗口',
      reload: '重新加载',
    }
    : {
      file: 'File',
      edit: 'Edit',
      view: 'View',
      window: 'Window',
      newWindow: 'New Window',
      reload: 'Reload',
    }
}

export function newWindowMenuItem(openWindow: () => void, locale = 'en'): NewWindowMenuItem {
  return {
    label: menuCopy(locale).newWindow,
    accelerator: 'CommandOrControl+Shift+N',
    click: openWindow,
  }
}
