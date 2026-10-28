import { useId, useRef } from "react";
import { createPortal } from "react-dom";

import type { SkillPlacement, SkillPreview } from "../common/ipc";
import type { SkillPlacementModel } from "./skill-placement";
import { useModalDialog } from "./use-modal-dialog";

export function SkillReviewModal({
  preview,
  busy,
  stopping,
  statusLine,
  error,
  placementModel,
  onPlace,
  onPrepare,
  onCancel,
  onClose,
  restoreFocus,
}: {
  preview: SkillPreview | null;
  busy: boolean;
  stopping: boolean;
  statusLine: string;
  error: string | null;
  placementModel: SkillPlacementModel;
  onPlace: (placement: SkillPlacement) => void;
  onPrepare: () => void;
  onCancel: () => void;
  onClose: () => void;
  restoreFocus: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useModalDialog(dialog, onClose, restoreFocus);

  return createPortal(
    <div className="sheet-backdrop" onClick={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        ref={dialog}
        className="sheet skill-review-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <div className="sheet-head">
          <h2 id={titleId}>Review SKILL.md</h2>
          <button className="ghost" onClick={onClose}>Close</button>
        </div>
        <p className="sheet-lead" id={descriptionId}>
          Read-only file preview, including frontmatter. Nothing is installed or exported until you choose an action below.
          Closing this window keeps the preview; editing the plan discards it.
        </p>
        {error && <p className="sheet-caution" role="alert">{error}</p>}
        {busy && (
          <div className="status-line" role="status">
            <span className="spinner" aria-hidden="true" />
            <span className="status-text">{statusLine || "Working…"}</span>
            <button className="linky status-cancel" onClick={onCancel} disabled={stopping}>Cancel</button>
          </div>
        )}
        {preview && (
          <pre className="skill-review-source" tabIndex={0} aria-label="SKILL.md source">
            <code>{preview.markdown}</code>
          </pre>
        )}
        {!preview && !busy && (
          <button className="ghost" onClick={onPrepare}>Prepare preview</button>
        )}
        <div className="sheet-actions skill-review-actions">
          {placementModel.actions.map((action) => (
            <button
              key={action.placement}
              className={action.primary ? "record-cta" : "ghost"}
              disabled={busy || !preview}
              onClick={() => onPlace(action.placement)}
              title={action.title}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
