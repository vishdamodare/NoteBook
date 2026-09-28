// Autosave state machine for the page editor.
//
//   idle ──edit──▶ dirty ──start──▶ saving ──ok──▶ saved ──edit──▶ dirty
//                    ▲                 │ ├─fail──▶ error ──retry/edit──▶ dirty
//                    └──edit(queued)───┘ └─conflict──▶ conflict (user chooses)
//
// Only one save is in flight at a time. Edits during a save are queued and
// saved afterwards, so an older save can never land after a newer one.

export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error" | "conflict";

export interface SaveState {
  status: SaveStatus;
  revision: number;
  /** Edits happened while a save was in flight. */
  queued: boolean;
  error: string | null;
}

export type SaveEvent =
  | { type: "edit" }
  | { type: "start" }
  | { type: "success"; revision: number }
  | { type: "failure"; error: string }
  | { type: "conflict" }
  | { type: "resolved"; revision: number; dirty: boolean };

export function initialSaveState(revision: number): SaveState {
  return { status: "idle", revision, queued: false, error: null };
}

export function saveReducer(state: SaveState, event: SaveEvent): SaveState {
  switch (event.type) {
    case "edit":
      if (state.status === "saving") return { ...state, queued: true };
      if (state.status === "conflict") return state; // stay blocked until the user resolves it
      return { ...state, status: "dirty", error: null };
    case "start":
      if (state.status !== "dirty" && state.status !== "error") return state;
      return { ...state, status: "saving", queued: false, error: null };
    case "success":
      if (state.status !== "saving") return state;
      return { ...state, revision: event.revision, status: state.queued ? "dirty" : "saved", queued: false };
    case "failure":
      if (state.status !== "saving") return state;
      return { ...state, status: "error", queued: false, error: event.error };
    case "conflict":
      return { ...state, status: "conflict", queued: false };
    case "resolved":
      return { ...state, revision: event.revision, status: event.dirty ? "dirty" : "saved", queued: false, error: null };
  }
}

export function hasUnsavedChanges(state: SaveState): boolean {
  return state.status === "dirty" || state.status === "saving" || state.status === "error" || state.status === "conflict";
}
