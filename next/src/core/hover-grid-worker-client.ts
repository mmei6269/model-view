import type { HoverGridPayload } from "../types";
import { normalizeOwnedBinaryHoverGridPayload } from "./hover-grid-payload";

const HOVER_GRID_WORKER_PROTOCOL_VERSION = 1;
const HOVER_GRID_WORKER_TIMEOUT_MS = 30_000;
const HOVER_GRID_WORKER_MAX_QUEUED_OWNERS = 1;

interface HoverGridWorkerDecodeRequest {
  type: "decode";
  protocolVersion: number;
  id: number;
  buffer: ArrayBuffer;
}

interface HoverGridWorkerDecodeResponse {
  type: "result";
  protocolVersion: number;
  id: number;
  payload: HoverGridPayload;
}

interface HoverGridDecodeJob {
  id: number;
  input: ArrayBuffer;
  signal?: AbortSignal;
  state: "queued" | "active";
  settled: boolean;
  transferred: boolean;
  timeoutId: ReturnType<typeof setTimeout> | null;
  abortListener: (() => void) | null;
  resolve: (payload: HoverGridPayload) => void;
  reject: (error: unknown) => void;
}

export class HoverGridWorkerOwnershipLostError extends Error {
  readonly ownershipLost = true;

  constructor(message: string) {
    super(message);
    this.name = "HoverGridWorkerOwnershipLostError";
  }
}

class HoverGridWorkerDecoder {
  private worker: Worker | null = null;
  private disabled = false;
  private nextId = 1;
  private active: HoverGridDecodeJob | null = null;
  private readonly queue: HoverGridDecodeJob[] = [];

  prewarm(): void {
    if (!this.canUseWorker()) {
      return;
    }
    try {
      this.ensureWorker();
    } catch {
      // Constructor/CSP failures retain page ownership, so normal decoding can
      // safely use the main-thread parser without a recovery fetch.
      this.disableWorker();
    }
  }

  decode(input: ArrayBuffer, signal?: AbortSignal): Promise<HoverGridPayload> {
    if (signal?.aborted) {
      return Promise.reject(createAbortError());
    }
    if (!this.canUseWorker()) {
      return Promise.resolve(normalizeOwnedBinaryHoverGridPayload(input));
    }
    if (this.active && this.queue.length >= HOVER_GRID_WORKER_MAX_QUEUED_OWNERS) {
      // A completed response body is already a 225+ MiB owner. Never retain
      // an unbounded timeline-scrub FIFO behind the worker: keep one active
      // transfer plus one page-owned queued buffer, and consume overload in
      // place on the main thread instead of adding another retained owner.
      return Promise.resolve(normalizeOwnedBinaryHoverGridPayload(input));
    }

    return new Promise<HoverGridPayload>((resolve, reject) => {
      const job: HoverGridDecodeJob = {
        id: this.nextId++,
        input,
        signal,
        state: "queued",
        settled: false,
        transferred: false,
        timeoutId: null,
        abortListener: null,
        resolve,
        reject,
      };
      if (signal) {
        job.abortListener = () => this.abortJob(job);
        signal.addEventListener("abort", job.abortListener, { once: true });
      }
      this.queue.push(job);
      this.pump();
    });
  }

  resetForTests(): void {
    this.worker?.terminate();
    this.worker = null;
    this.disabled = false;
    this.nextId = 1;
    if (this.active) {
      this.finish(this.active, undefined, new Error("Hover worker reset"));
    }
    for (const job of this.queue.splice(0)) {
      this.settle(job, undefined, new Error("Hover worker reset"));
    }
  }

  private canUseWorker(): boolean {
    return !this.disabled && typeof Worker === "function";
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }
    const worker = new Worker(new URL("./hover-grid-payload.worker.ts", import.meta.url), {
      type: "module",
      name: "hover-grid-normalizer",
    });
    worker.addEventListener("message", (event: MessageEvent<HoverGridWorkerDecodeResponse>) => {
      this.handleMessage(worker, event.data);
    });
    worker.addEventListener("error", (event) => {
      event.preventDefault();
      this.handleWorkerFailure(worker, event.message || "Hover grid worker crashed");
    });
    worker.addEventListener("messageerror", () => {
      this.handleWorkerFailure(worker, "Hover grid worker returned an unreadable message");
    });
    this.worker = worker;
    return worker;
  }

  private pump(): void {
    if (this.active || this.queue.length === 0) {
      return;
    }
    const job = this.queue.shift();
    if (!job) {
      return;
    }
    if (job.signal?.aborted) {
      this.settle(job, undefined, createAbortError());
      this.pump();
      return;
    }
    if (!this.canUseWorker()) {
      this.decodeOnMainThread(job);
      return;
    }

    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch {
      this.disableWorker();
      this.decodeOnMainThread(job);
      return;
    }

    job.state = "active";
    this.active = job;
    const request: HoverGridWorkerDecodeRequest = {
      type: "decode",
      protocolVersion: HOVER_GRID_WORKER_PROTOCOL_VERSION,
      id: job.id,
      buffer: job.input,
    };
    try {
      worker.postMessage(request, [job.input]);
      job.transferred = job.input.byteLength === 0;
    } catch (error) {
      const ownershipLost = job.input.byteLength === 0;
      job.transferred = ownershipLost;
      this.worker?.terminate();
      this.worker = null;
      this.disabled = true;
      if (ownershipLost) {
        this.finish(job, undefined, ownershipLostError(error));
      } else {
        this.finish(job, normalizeOwnedBinaryHoverGridPayload(job.input));
      }
      return;
    }
    job.timeoutId = setTimeout(() => {
      this.handleWorkerFailure(worker, "Hover grid worker timed out");
    }, HOVER_GRID_WORKER_TIMEOUT_MS);
  }

  private decodeOnMainThread(job: HoverGridDecodeJob): void {
    job.state = "active";
    this.active = job;
    try {
      this.finish(job, normalizeOwnedBinaryHoverGridPayload(job.input));
    } catch (error) {
      this.finish(job, undefined, error);
    }
  }

  private handleMessage(worker: Worker, message: HoverGridWorkerDecodeResponse): void {
    if (worker !== this.worker) {
      return;
    }
    const job = this.active;
    if (!job || message?.id !== job.id) {
      this.handleWorkerFailure(worker, "Hover grid worker response id did not match the active request");
      return;
    }
    if (
      message.type !== "result" ||
      message.protocolVersion !== HOVER_GRID_WORKER_PROTOCOL_VERSION ||
      !isUsableHoverGridPayload(message.payload)
    ) {
      this.handleWorkerFailure(worker, "Hover grid worker response failed its protocol gate");
      return;
    }
    this.finish(job, message.payload);
  }

  private handleWorkerFailure(worker: Worker, message: string): void {
    if (worker !== this.worker) {
      return;
    }
    worker.terminate();
    this.worker = null;
    this.disabled = true;
    const job = this.active;
    if (job) {
      this.finish(
        job,
        undefined,
        job.transferred ? new HoverGridWorkerOwnershipLostError(message) : new Error(message),
      );
      return;
    }
    this.pump();
  }

  private abortJob(job: HoverGridDecodeJob): void {
    if (job.settled) {
      return;
    }
    if (job.state === "queued") {
      const index = this.queue.indexOf(job);
      if (index >= 0) {
        this.queue.splice(index, 1);
      }
      this.settle(job, undefined, createAbortError());
      return;
    }

    // Transferred work cannot be synchronously interrupted during predictor
    // reconstruction. Reject this consumer now, keep the job as the single active owner,
    // then discard its eventual result before admitting the next buffer.
    this.settle(job, undefined, createAbortError(), false);
  }

  private finish(job: HoverGridDecodeJob, payload?: HoverGridPayload, error?: unknown): void {
    if (job.timeoutId !== null) {
      clearTimeout(job.timeoutId);
      job.timeoutId = null;
    }
    if (this.active === job) {
      this.active = null;
    }
    this.settle(job, payload, error);
    queueMicrotask(() => this.pump());
  }

  private settle(
    job: HoverGridDecodeJob,
    payload?: HoverGridPayload,
    error?: unknown,
    removeAbortListener = true,
  ): void {
    if (job.settled) {
      if (removeAbortListener) {
        this.removeAbortListener(job);
      }
      return;
    }
    job.settled = true;
    if (removeAbortListener) {
      this.removeAbortListener(job);
    }
    if (error !== undefined) {
      job.reject(error);
    } else if (payload) {
      job.resolve(payload);
    } else {
      job.reject(new Error("Hover grid decode completed without a payload"));
    }
  }

  private removeAbortListener(job: HoverGridDecodeJob): void {
    if (job.signal && job.abortListener) {
      job.signal.removeEventListener("abort", job.abortListener);
      job.abortListener = null;
    }
  }

  private disableWorker(): void {
    this.worker?.terminate();
    this.worker = null;
    this.disabled = true;
  }
}

const hoverGridWorkerDecoder = new HoverGridWorkerDecoder();

export function prewarmHoverGridPayloadWorker(): void {
  hoverGridWorkerDecoder.prewarm();
}

export function normalizeOwnedBinaryHoverGridPayloadOffMainThread(
  input: ArrayBuffer,
  signal?: AbortSignal,
): Promise<HoverGridPayload> {
  return hoverGridWorkerDecoder.decode(input, signal);
}

export function isHoverGridWorkerOwnershipLostError(error: unknown): error is HoverGridWorkerOwnershipLostError {
  return (
    error instanceof HoverGridWorkerOwnershipLostError ||
    (typeof error === "object" && error !== null && (error as { ownershipLost?: unknown }).ownershipLost === true)
  );
}

export function _testResetHoverGridWorkerDecoder(): void {
  hoverGridWorkerDecoder.resetForTests();
}

function ownershipLostError(error: unknown): HoverGridWorkerOwnershipLostError {
  const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
  return new HoverGridWorkerOwnershipLostError(`Hover grid worker lost transferred ownership${detail}`);
}

function createAbortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

export function isUsableHoverGridPayload(value: unknown): value is HoverGridPayload {
  try {
    if (!isPlainRecord(value)) {
      return false;
    }
    const payload = value as Partial<HoverGridPayload>;
    const schemaVersion = payload.schemaVersion;
    const rows = payload.rows;
    const cols = payload.cols;
    if (
      typeof schemaVersion !== "number" ||
      !Number.isSafeInteger(schemaVersion) ||
      schemaVersion < 1 ||
      schemaVersion > 4 ||
      typeof rows !== "number" ||
      !Number.isSafeInteger(rows) ||
      rows <= 0 ||
      typeof cols !== "number" ||
      !Number.isSafeInteger(cols) ||
      cols <= 0 ||
      rows > Number.MAX_SAFE_INTEGER / cols
    ) {
      return false;
    }
    const cellCount = rows * cols;
    if (
      !Number.isSafeInteger(cellCount) ||
      cellCount > Number.MAX_SAFE_INTEGER / Int16Array.BYTES_PER_ELEMENT ||
      !isPlainRecord(payload.variables)
    ) {
      return false;
    }
    const variables = Object.entries(payload.variables);
    if (variables.length === 0) {
      return schemaVersion === 3 || schemaVersion === 4;
    }
    for (const [key, variable] of variables) {
      if (
        !isSafeHoverGridVariableKey(key) ||
        !isPlainRecord(variable) ||
        typeof variable.scale !== "number" ||
        !Number.isFinite(variable.scale) ||
        variable.scale <= 0 ||
        typeof variable.offset !== "number" ||
        !Number.isFinite(variable.offset) ||
        typeof variable.missing !== "number" ||
        !Number.isInteger(variable.missing) ||
        variable.missing < -32768 ||
        variable.missing > 32767 ||
        !(variable.values instanceof Int16Array) ||
        !(variable.values.buffer instanceof ArrayBuffer) ||
        variable.values.length !== cellCount
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeHoverGridVariableKey(key: string): boolean {
  return key.length > 0 && key !== "__proto__" && key !== "constructor" && key !== "prototype";
}
