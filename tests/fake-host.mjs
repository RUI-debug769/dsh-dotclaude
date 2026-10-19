/**
 * Minimal host double for plugin tests.
 *
 * It reproduces only the Cordis members `apply()` calls: `get`, `on`,
 * `effect`, and `inject`. Nothing here mirrors a real service; each test
 * supplies the services it wants the plugin to see.
 */

/**
 * Build a fake plugin context.
 * @param {object} options - `services` maps host service names to doubles.
 * @returns {{ctx: object, emitted: object[], dispose: () => void, listeners: Map<string, Function[]>}}
 */
export function createHost({ services = {} } = {}) {
  const listeners = new Map()
  const disposers = []
  const emitted = []
  const ctx = {
    get(name) {
      return services[name]
    },
    on(event, handler) {
      const bucket = listeners.get(event) ?? []
      bucket.push(handler)
      listeners.set(event, bucket)
      return () => true
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    inject(_keys, callback) {
      callback(ctx)
    },
  }
  return {
    ctx,
    emitted,
    listeners,
    async emit(event, payload, ...rest) {
      emitted.push({ event, payload })
      const bucket = listeners.get(event) ?? []
      let result
      for (const handler of bucket) result = await handler(payload, ...rest)
      return result
    },
    dispose() {
      for (const disposer of disposers.reverse()) disposer()
    },
  }
}

/**
 * Build a fake command registry.
 * @param {object} options - `taken` names already registered, `listThrows`, `registerThrows`.
 * @returns {{registered: object[], register: Function, list: Function}}
 */
export function createCommandRegistry({ taken = [], listThrows = false, registerThrows = false } = {}) {
  const registered = []
  return {
    registered,
    register(definition) {
      if (registerThrows) throw new Error('registration rejected')
      registered.push(definition)
      return () => {}
    },
    list() {
      if (listThrows) throw new Error('list unavailable')
      return taken.map(name => ({ name }))
    },
  }
}

/**
 * Build a fake agent carrying a session, a scoped context, and a message log.
 * @param {object} options - `sessionId`, `cwd`, and scoped `services`.
 * @returns {{session: object, ctx: object, followup: Function, messages: object[]}}
 */
export function createAgent({ sessionId = 'session-1', cwd, services = {} } = {}) {
  const messages = []
  return {
    messages,
    session: { id: sessionId, header: { cwd }, append() {} },
    ctx: {
      get(name) {
        return services[name]
      },
      inject(_keys, callback) {
        callback(this)
      },
      effect() {},
      on() {
        return () => true
      },
    },
    followup(message) {
      messages.push(message)
    },
  }
}

/**
 * Build a working-directory service over a fixed map.
 * @param {Record<string, string>} bySession - session id to absolute directory.
 * @returns {{get: (session: {id: string}) => string}}
 */
export function createWorkingDirectory(bySession) {
  return {
    get(session) {
      return bySession[session.id]
    },
  }
}
