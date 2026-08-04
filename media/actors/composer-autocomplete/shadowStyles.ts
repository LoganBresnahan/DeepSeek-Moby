/**
 * Composer autocomplete styles.
 *
 * Minimal for now — the overlay renders as a plain list on top of
 * `popupBaseStyles`. Anchoring it as a full-width bar above the composer
 * (ADR 0015 decision 5) lands with the overlay slice.
 */

export const composerAutocompleteShadowStyles = `
  .autocomplete-empty {
    padding: 8px 12px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }

  .autocomplete-item-detail {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.8;
    margin-left: auto;
    padding-left: 12px;
  }
`;
