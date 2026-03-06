import { useCallback, useEffect, useState } from "react";
import { ForgeProvider, useForgeState, useForgeDispatch } from "../state/forge-context";
import { PropGallery } from "./PropGallery";
import { StageTabs } from "./StageTabs";
import { Workspace } from "./Workspace";
import { StatusStrip } from "./StatusStrip";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { usePipelineActions } from "../hooks/usePipelineActions";
import { ExperimentRouteDrawer } from "../../../components/ExperimentRouteDrawer";
import { StyleGuidePanel } from "../../forge-core/StyleGuidePanel";

function ForgeShellInner() {
  const state = useForgeState();
  const dispatch = useForgeDispatch();
  const actions = usePipelineActions();
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);

  // Initialize on mount
  useEffect(() => {
    void actions.initialize();
  }, [actions.initialize]);

  // Primary action for keyboard shortcut
  const handlePrimaryAction = useCallback(() => {
    const draft = state.selectedDraftId ? state.drafts.get(state.selectedDraftId) ?? null : null;
    switch (state.activeStage) {
      case "ref":
        if (draft) {
          void actions.runImageGenerationForDraft(draft, "current-style");
        }
        break;
      case "mesh":
        if (draft?.conceptImage) {
          void actions.runMeshGenerationForDraft(draft);
        }
        break;
      case "phy":
        void actions.computeSelectedPhysicsColliders();
        break;
    }
  }, [actions, state.activeStage, state.drafts, state.selectedDraftId]);

  useKeyboardShortcuts({ onPrimaryAction: handlePrimaryAction });

  const handleSelectProp = useCallback((propId: string) => {
    setBatchOpen(false);
    void actions.selectProp(propId);
  }, [actions]);

  const selectExperimentFromMenu = useCallback((id: string) => {
    window.location.hash = `#/exp/${id}`;
    setMenuOpen(false);
  }, []);

  const selectForgeFromMenu = useCallback(() => {
    window.location.hash = "#/forge";
    setMenuOpen(false);
  }, []);

  return (
    <div className="ps-shell forge-app" data-testid="forge-page">
      <ExperimentRouteDrawer
        open={menuOpen}
        active={{ type: "forge" }}
        onClose={() => setMenuOpen(false)}
        onSelectForge={selectForgeFromMenu}
        onSelectExperiment={selectExperimentFromMenu}
      />

      {/* Top: Gallery filmstrip */}
      <header className="ps-shell-header">
        <PropGallery onSelectProp={handleSelectProp} onAddClick={() => setBatchOpen(true)} />
        <div className="ps-header-actions">
          <button
            className={`ps-menu-btn ${settingsOpen ? "ps-menu-btn-active" : ""}`}
            onClick={() => setSettingsOpen((v) => !v)}
            aria-label="Style guide settings"
            title="Style Guide"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
            </svg>
          </button>
          <button
            className={`ps-menu-btn ${menuOpen ? "ps-menu-btn-active" : ""}`}
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Toggle experiment menu"
            aria-expanded={menuOpen}
            title="Experiments"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
        </div>
      </header>

      {/* Main: Tabs + Workspace */}
      <div className="ps-shell-body">
        <StageTabs />
        <Workspace />
      </div>

      {/* Global Style Guide overlay */}
      {settingsOpen && (
        <div className="ps-settings-overlay">
          <div className="ps-settings-panel">
            <div className="ps-settings-header">
              <strong>Style Guide</strong>
              <button className="ps-batch-close" onClick={() => setSettingsOpen(false)}>×</button>
            </div>
            <div className="ps-settings-body">
              <StyleGuidePanel
                value={state.styleGuide}
                onChange={(guide) => dispatch({ type: "SET_STYLE_GUIDE", guide })}
              />
            </div>
          </div>
        </div>
      )}

      {/* Add Props modal */}
      {batchOpen && (
        <div className="ps-settings-overlay">
          <div className="ps-settings-panel">
            <div className="ps-settings-header">
              <strong>Add Props</strong>
              <button className="ps-batch-close" onClick={() => setBatchOpen(false)}>×</button>
            </div>
            <div className="ps-settings-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <textarea
                className="ps-textarea"
                rows={8}
                value={state.batchText}
                onChange={(e) => dispatch({ type: "SET_BATCH_TEXT", text: e.target.value })}
                placeholder={"wooden chair\nstone well\niron lantern\n\nOne description per line"}
                autoFocus
              />
              <button
                className="forge-btn forge-btn-primary"
                style={{ alignSelf: "flex-end" }}
                onClick={() => {
                  void actions.createPropPlaceholders();
                  setBatchOpen(false);
                }}
                disabled={!state.batchText.trim()}
              >
                Create Props
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bottom: Status strip */}
      <StatusStrip />
    </div>
  );
}

export function ForgeShell() {
  return (
    <ForgeProvider>
      <ForgeShellInner />
    </ForgeProvider>
  );
}
