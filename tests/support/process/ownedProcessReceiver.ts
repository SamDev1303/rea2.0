import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

const pending = new Set<ChildProcess>();
interface ReceiverState {
  readonly owner: object;
  readonly retainFailure: (cause: unknown) => void;
  readonly ready: Promise<void>;
  forced: boolean;
  unconfirmed: boolean;
  cleanup: boolean;
  readyObserved: boolean;
  closeOutcome?: {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  };
  failures: unknown[];
  closing?: Promise<void> | undefined;
}
const states = new WeakMap<ChildProcess, ReceiverState>();
export const recordReceiverFailure = (
  child: ChildProcess,
  cause: unknown,
): void => {
  const state = states.get(child);
  if (state && !state.failures.includes(cause)) {
    state.failures.push(cause);
    state.retainFailure(cause);
  }
};
export const hasPendingOwnedReceiver = (child: ChildProcess): boolean =>
  pending.has(child);
export const waitOwnedReceiverReady = (child: ChildProcess): Promise<void> => {
  const state = states.get(child);
  if (!state) return Promise.reject(new Error("Exact owned receiver required"));
  return state.ready;
};

/** FD4 binds the exact receiver; target inheritance needs native-route verification. */
export const registerOwnedReceiver = (
  child: ChildProcess,
  owner: object,
  retainFailure: (cause: unknown) => void,
): Promise<void> => {
  if (states.has(child)) throw new Error("Receiver already registered");
  let ready!: () => void;
  let rejectReady!: (cause: unknown) => void;
  const readiness = new Promise<void>((resolve, reject) => {
    ready = resolve;
    rejectReady = reject;
  });
  void readiness.catch(() => {});
  const state: ReceiverState = {
    owner,
    retainFailure,
    ready: readiness,
    forced: false,
    unconfirmed: false,
    cleanup: false,
    readyObserved: false,
    failures: [],
  };
  states.set(child, state);
  pending.add(child);
  const control = child.stdio[4] as Readable | null | undefined;
  let buffer = "";
  let bytes = 0;
  const controlFailure = (cause: unknown) => {
    state.unconfirmed = true;
    recordReceiverFailure(child, cause);
    rejectReady(cause);
  };
  const onData = (chunk: Buffer) => {
    if (state.unconfirmed) return;
    bytes += chunk.length;
    if (bytes > 1024) {
      controlFailure(new Error("Receiver control channel exceeds budget"));
      return;
    }
    buffer += chunk.toString("utf8");
    for (;;) {
      if (state.unconfirmed) return;
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line) as unknown;
        if (
          message === null ||
          typeof message !== "object" ||
          Array.isArray(message)
        )
          throw new Error("Invalid receiver control frame");
        const keys = Object.keys(message).sort().join(",");
        if (
          keys === "type" &&
          "type" in message &&
          message.type === "ready" &&
          !state.readyObserved &&
          !state.cleanup
        ) {
          state.readyObserved = true;
          ready();
        } else if (
          keys === "complete,type" &&
          "type" in message &&
          message.type === "cleanup" &&
          "complete" in message &&
          typeof message.complete === "boolean" &&
          state.readyObserved &&
          !state.cleanup
        ) {
          if (!message.complete)
            controlFailure(new Error("Receiver reports incomplete cleanup"));
          else state.cleanup = true;
        } else throw new Error("Invalid receiver control transition");
      } catch (cause) {
        controlFailure(cause);
      }
    }
  };
  const onError = (cause: Error) => recordReceiverFailure(child, cause);
  child.on("error", onError);
  if (control && "on" in control) {
    control.on("data", onData);
    control.on("error", controlFailure);
  } else controlFailure(new Error("Missing private receiver control socket"));
  return new Promise<void>((resolve) =>
    child.once(
      "close",
      (code: number | null, signal: NodeJS.Signals | null) => {
        state.closeOutcome = Object.freeze({ code, signal });
        if (
          state.forced ||
          !state.cleanup ||
          signal !== null ||
          (code !== 0 && code !== 130 && code !== 1) ||
          buffer.length > 0
        ) {
          state.unconfirmed = true;
          recordReceiverFailure(
            child,
            new Error("Receiver close does not confirm complete cleanup", {
              cause: state.closeOutcome,
            }),
          );
        }
        if (!state.readyObserved)
          rejectReady(new Error("Receiver closed before readiness"));
        child.removeListener("error", onError);
        control?.removeListener("data", onData);
        control?.removeListener("error", controlFailure);
        if (!state.forced && !state.unconfirmed) pending.delete(child);
        resolve();
      },
    ),
  );
};

/** Wait for installed handlers, then cooperative cleanup; forced close retains the graph. */
export const stopOwnedReceiver = (child: ChildProcess): Promise<void> => {
  const state = states.get(child);
  if (!state || !pending.has(child)) return Promise.resolve();
  if (state.closing) return state.closing;
  if (state.closeOutcome || state.forced)
    return Promise.reject(
      new AggregateError(
        [...state.failures],
        "Receiver cleanup remains unconfirmed; enclosing owner retained",
      ),
    );
  state.closing = new Promise<void>((resolve, reject) => {
    let grace: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const detach = () => {
      clearTimeout(grace);
      clearTimeout(deadline);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
    };
    const fail = (cause: unknown) => {
      if (finished) return;
      finished = true;
      detach();
      recordReceiverFailure(child, cause);
      reject(
        new AggregateError(
          [...state.failures],
          "Owned receiver shutdown attempts incomplete",
        ),
      );
    };
    const onError = (cause: Error) => fail(cause);
    const onClose = () => {
      if (state.forced || state.unconfirmed)
        fail(new Error("Receiver close does not verify target-tree cleanup"));
      else {
        finished = true;
        detach();
        resolve();
      }
    };
    const signal = (value: NodeJS.Signals) => {
      try {
        if (!child.kill(value))
          throw new Error(`Receiver refused ${value}; cleanup unconfirmed`);
      } catch (cause) {
        fail(cause);
      }
    };
    child.once("close", onClose);
    child.once("error", onError);
    grace = setTimeout(() => {
      state.forced = true;
      recordReceiverFailure(
        child,
        new Error(
          "Receiver exceeded cooperative grace; target-tree cleanup unconfirmed",
        ),
      );
      deadline = setTimeout(
        () => fail(new Error("Receiver did not close after bounded SIGKILL")),
        2000,
      );
      signal("SIGKILL");
    }, 10000);
    if (state.readyObserved) {
      if (!state.cleanup) signal("SIGTERM");
    } else
      void state.ready.then(
        () => {
          if (!finished && !state.forced && !state.cleanup) signal("SIGTERM");
        },
        (cause: unknown) => {
          recordReceiverFailure(child, cause);
        },
      );
  }).finally(() => {
    state.closing = undefined;
  });
  return state.closing;
};
export const retryPendingOwnedProcessReceivers = async (): Promise<void> => {
  const results = await Promise.allSettled([...pending].map(stopOwnedReceiver));
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  if (failures.length)
    throw new AggregateError(failures, "Owned receivers remain retained");
};
