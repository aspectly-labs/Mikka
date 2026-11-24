"use client"

import { useSyncExternalStore } from "react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheck, Info, TriangleAlert, OctagonX, LoaderCircle } from "@/components/icons"

/** Phone widths: a status toast drops in at the top, under the bar, never over the composer at the bottom. */
const PHONE = "(max-width: 767px)"
const watchPhone = (change: () => void) => {
  const query = window.matchMedia(PHONE)
  query.addEventListener("change", change)
  return () => query.removeEventListener("change", change)
}

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()
  const phone = useSyncExternalStore(watchPhone, () => window.matchMedia(PHONE).matches, () => false)

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      position={phone ? "top-center" : "bottom-right"}
      mobileOffset={{ top: "calc(env(safe-area-inset-top) + 56px)" }}
      className="toaster group"
      icons={{
        success: (
          <CircleCheck className="size-4" />
        ),
        info: (
          <Info className="size-4" />
        ),
        warning: (
          <TriangleAlert className="size-4" />
        ),
        error: (
          <OctagonX className="size-4" />
        ),
        loading: (
          <LoaderCircle className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
