/**
 * Level-4 user confirmation dialog for low-confidence classifications.
 *
 * When the heuristic classifier returns confidence < 0.80, the ingest
 * pipeline calls `promptIngestStrategy` to ask the user to confirm or
 * override the suggested strategy. The dialog is pre-populated with
 * the system's reasoning so the user can make an informed decision
 * rather than starting from a blank choice.
 *
 * The dialog is implemented as a Promise-returning function rather
 * than a React component tree because it's called from the ingest
 * pipeline (src/lib/ingest.ts), which is not a React render context.
 * The UI is rendered imperatively into a portal.
 */
import type { ClassificationResult, IngestStrategy } from "@/types/ingest"

/**
 * Show a confirmation dialog and resolve with the user's chosen
 * strategy. If the user dismisses the dialog, resolves with the
 * classifier's best guess (or "fixed" as the safe fallback).
 */
export function promptIngestStrategy(
  classification: ClassificationResult,
  fileName: string,
): Promise<IngestStrategy> {
  return new Promise((resolve) => {
    // Render an overlay dialog imperatively. This is a lightweight
    // approach that doesn't require a React portal tree — it builds
    // DOM nodes directly and removes them when done.
    const overlay = document.createElement("div")
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 9999;
      background: rgba(0, 0, 0, 0.5);
      display: flex; align-items: center; justify-content: center;
      font-family: inherit;
    `

    const dialog = document.createElement("div")
    dialog.style.cssText = `
      background: var(--background, #fff);
      color: var(--foreground, #000);
      border-radius: 12px; padding: 24px; max-width: 520px; width: 90%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      max-height: 80vh; overflow-y: auto;
    `

    const confidencePct = Math.round(classification.confidence * 100)
    const reasoningHtml = classification.reasoning
      .slice(0, 5)
      .map((r) => `<li style="margin: 2px 0; color: var(--muted-foreground, #666); font-size: 13px;">• ${escapeHtml(r)}</li>`)
      .join("")

    dialog.innerHTML = `
      <h2 style="font-size: 18px; font-weight: 600; margin: 0 0 8px;">
        Ingest Strategy
      </h2>
      <p style="font-size: 14px; margin: 0 0 4px; color: var(--muted-foreground, #666);">
        File: <strong>${escapeHtml(fileName)}</strong>
      </p>
      <p style="font-size: 14px; margin: 0 0 12px;">
        Detected: <strong>${classification.strategy}</strong>
        (${confidencePct}% confidence)
      </p>
      <p style="font-size: 13px; color: var(--muted-foreground, #666); margin: 0 0 8px;">
        Confidence is below the auto-apply threshold. Please confirm or choose a different strategy.
      </p>
      <ul style="list-style: none; padding: 0; margin: 0 0 16px;">
        ${reasoningHtml}
      </ul>
      <div id="ingest-strategy-buttons" style="display: flex; flex-direction: column; gap: 8px;">
        ${strategyButton(classification.strategy, true)}
        ${strategyButton("encyclopedia", false)}
        ${strategyButton("narrative", false)}
        ${strategyButton("tabular", false)}
        ${strategyButton("fixed", false)}
      </div>
      <button id="ingest-strategy-cancel" style="
        margin-top: 12px; width: 100%; padding: 8px;
        border: 1px solid var(--border, #ddd); border-radius: 8px;
        background: transparent; color: var(--muted-foreground, #666);
        cursor: pointer; font-size: 13px;
      ">Cancel (skip ingest)</button>
    `

    overlay.appendChild(dialog)
    document.body.appendChild(overlay)

    const cleanup = () => {
      overlay.remove()
    }

    // Wire up buttons
    const buttons = dialog.querySelectorAll<HTMLElement>("[data-strategy]")
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        cleanup()
        resolve(btn.dataset.strategy as IngestStrategy)
      })
    })

    const cancelBtn = dialog.querySelector("#ingest-strategy-cancel")
    cancelBtn?.addEventListener("click", () => {
      cleanup()
      // On cancel, use the classifier's best guess as a fallback
      resolve(classification.strategy)
    })

    // Click on overlay backdrop = cancel
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        cleanup()
        resolve(classification.strategy)
      }
    })
  })
}

function strategyButton(strategy: string, suggested: boolean): string {
  const labels: Record<string, string> = {
    encyclopedia: "Encyclopedia Mode",
    narrative: "Narrative Mode",
    tabular: "Tabular / Glossary Mode",
    fixed: "Fixed Chunks (legacy)",
  }
  const label = labels[strategy] ?? strategy
  const badge = suggested ? ' <span style="font-size: 11px; color: var(--primary, #0066cc);">(suggested)</span>' : ""
  return `
    <button data-strategy="${strategy}" style="
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px; border: 1px solid var(--border, #ddd);
      border-radius: 8px; background: ${suggested ? "var(--primary/5, rgba(0,102,204,0.05))" : "transparent"};
      color: var(--foreground, #000); cursor: pointer; font-size: 14px;
      text-align: left; transition: background 0.15s;
    ">
      <span>${label}${badge}</span>
    </button>
  `
}

function escapeHtml(text: string): string {
  const div = document.createElement("div")
  div.textContent = text
  return div.innerHTML
}
