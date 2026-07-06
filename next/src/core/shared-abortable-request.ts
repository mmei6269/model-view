interface SharedRequestEntry<T> {
  controller: AbortController;
  consumers: number;
  promise: Promise<T>;
}

export type SharedRequestMap<T> = Map<string, SharedRequestEntry<T>>;

export function createSharedRequestMap<T>(): SharedRequestMap<T> {
  return new Map<string, SharedRequestEntry<T>>();
}

/**
 * Dedupes concurrent requests by key without binding any single caller's
 * AbortSignal to the underlying fetch. Each caller gets its own promise that
 * rejects when ITS signal aborts; the underlying request is aborted only once
 * every registered consumer has aborted. Consumers without a signal pin the
 * request for its full lifetime. Late joiners attach to the in-flight request.
 */
export function runSharedRequest<T>(
  inFlight: SharedRequestMap<T>,
  key: string,
  signal: AbortSignal | undefined,
  start: (sharedSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }
  let entry = inFlight.get(key);
  if (!entry) {
    const controller = new AbortController();
    // start() runs before the map entry exists, so a synchronous re-entrant
    // call on the same key (single-URL hover grids nest the per-URL fetch
    // inside the merged fetch) creates its own entry that the set() below
    // replaces; the controller identity checks keep cleanup scoped per entry.
    const promise = start(controller.signal).finally(() => {
      const current = inFlight.get(key);
      if (current && current.controller === controller) {
        inFlight.delete(key);
      }
    });
    // Rejections are delivered through per-consumer promises; keep a handler
    // on the shared promise so fully-detached requests stay silent.
    void promise.catch(() => undefined);
    entry = { controller, consumers: 0, promise };
    inFlight.set(key, entry);
  }
  const attached = entry;
  attached.consumers += 1;
  if (!signal) {
    return attached.promise;
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      attached.consumers -= 1;
      if (attached.consumers <= 0) {
        if (inFlight.get(key) === attached) {
          inFlight.delete(key);
        }
        attached.controller.abort();
      }
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    attached.promise.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function createAbortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}
