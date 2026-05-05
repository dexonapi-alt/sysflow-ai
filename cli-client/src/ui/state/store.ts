/**
 * Tiny pub/sub store. Avoids pulling in Redux/Zustand for what is essentially
 * a few mutable slices.
 *
 * Usage:
 *   const store = createStore({ count: 0 })
 *   store.subscribe((s) => console.log(s.count))
 *   store.set((s) => ({ count: s.count + 1 }))
 *
 * In components, prefer the `useStore` hook below — it bridges to React.
 */

import { useEffect, useState } from "react"

type Updater<T> = (state: T) => T
type Listener<T> = (state: T) => void

export interface Store<T> {
  get(): T
  set(updater: Updater<T> | Partial<T>): void
  subscribe(listener: Listener<T>): () => void
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<Listener<T>>()

  return {
    get: () => state,
    set: (updater) => {
      const next = typeof updater === "function"
        ? (updater as Updater<T>)(state)
        : { ...state, ...updater }
      if (Object.is(next, state)) return
      state = next
      for (const l of listeners) l(state)
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** React binding — re-renders when the store changes. */
export function useStore<T, S>(store: Store<T>, selector: (state: T) => S): S {
  const [slice, setSlice] = useState<S>(() => selector(store.get()))
  useEffect(() => {
    return store.subscribe((next) => {
      const value = selector(next)
      setSlice((prev) => (Object.is(prev, value) ? prev : value))
    })
  }, [store, selector])
  return slice
}
