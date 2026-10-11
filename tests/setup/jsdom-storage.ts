// Node >= 25 ships Web Storage on globalThis: `localStorage` / `sessionStorage`
// are accessor properties that return undefined (with an ExperimentalWarning)
// unless node runs with --localstorage-file. Vitest 3's jsdom environment only
// copies a window key onto the global when the key is NOT already `in global`
// (or is on its own allow-list, which Storage is not), so Node's empty getters
// shadow jsdom's working Storage and every `localStorage.x` throws.
//
// Re-point both globals at the jsdom window's Storage. This is a no-op on
// Node < 25 (where vitest already installed jsdom's Storage, so this re-installs
// the same object) and does nothing outside the jsdom environment.
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom

if (dom) {
  for (const key of ['localStorage', 'sessionStorage'] as const) {
    // Unconditional: even reading Node's getter emits an ExperimentalWarning.
    const storage = dom.window[key]
    Object.defineProperty(globalThis, key, { get: () => storage, configurable: true })
  }
}
