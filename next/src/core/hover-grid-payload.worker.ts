import type { HoverGridPayload } from "../types";
import { normalizeOwnedBinaryHoverGridPayload } from "./hover-grid-payload";

const HOVER_GRID_WORKER_PROTOCOL_VERSION = 1;

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

interface HoverGridWorkerScope {
  addEventListener(type: "message", listener: (event: MessageEvent<HoverGridWorkerDecodeRequest>) => void): void;
  postMessage(message: HoverGridWorkerDecodeResponse, transfer: Transferable[]): void;
}

const workerScope = globalThis as unknown as HoverGridWorkerScope;

workerScope.addEventListener("message", (event) => {
  const message = event.data;
  if (
    message?.type !== "decode" ||
    message.protocolVersion !== HOVER_GRID_WORKER_PROTOCOL_VERSION ||
    !Number.isSafeInteger(message.id) ||
    !(message.buffer instanceof ArrayBuffer)
  ) {
    return;
  }

  // The page transfers exclusive ownership here. The production parser keeps
  // all canonical MVH3/MVH4 variables as views over that one owner; compatible
  // fallback layouts may instead produce multiple isolated owners.
  const payload = normalizeOwnedBinaryHoverGridPayload(message.buffer);
  const backingStores = new Set<ArrayBuffer>();
  for (const variable of Object.values(payload.variables || {})) {
    if (variable?.values?.buffer instanceof ArrayBuffer) {
      backingStores.add(variable.values.buffer);
    }
  }
  workerScope.postMessage(
    {
      type: "result",
      protocolVersion: HOVER_GRID_WORKER_PROTOCOL_VERSION,
      id: message.id,
      payload,
    },
    Array.from(backingStores),
  );
});
