import { useEffect, useState } from "react"

interface Size {
  columns: number
  rows: number
}

function readSize(): Size {
  return {
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  }
}

/** Re-renders the consuming component when the terminal is resized. */
export function useTerminalSize(): Size {
  const [size, setSize] = useState<Size>(readSize)
  useEffect(() => {
    const onResize = (): void => setSize(readSize())
    process.stdout.on("resize", onResize)
    return () => {
      process.stdout.off("resize", onResize)
    }
  }, [])
  return size
}
