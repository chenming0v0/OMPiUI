export class SessionStopCoordinator {
  private readonly pending = new Map<string, Promise<void>>()

  stop(key: string, operation: () => Promise<unknown>): Promise<void> {
    const existing = this.pending.get(key)
    if (existing) return existing

    // Register before dispatch: a same-tick repeated click shares the outcome.
    const flight = Promise.resolve().then(operation).then(() => undefined).finally(() => {
      if (this.pending.get(key) === flight) this.pending.delete(key)
    })
    this.pending.set(key, flight)
    return flight
  }

  async submit<T>(key: string, operation: () => Promise<T>): Promise<T> {
    // An ACK only releases command ordering, not the session's busy/settled state.
    // Native admission still decides whether this prompt starts or queues a turn.
    while (this.pending.has(key)) await this.pending.get(key)
    return operation()
  }
}
