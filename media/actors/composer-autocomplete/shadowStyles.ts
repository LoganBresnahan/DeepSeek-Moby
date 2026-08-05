/**
 * Composer autocomplete styles.
 *
 * The overlay is a full-width bar pinned above the composer (ADR 0015
 * decision 5), styled to read as one surface with the input it completes —
 * VS Code's own suggest widget is the reference.
 */

export const composerAutocompleteShadowStyles = `
  .popup-container {
    /* Anchored to the composer box, so the base min-width must not fight it. */
    min-width: 0;
    max-height: 260px;
    border-radius: 4px;
    box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.3);
  }

  .popup-body {
    max-height: 260px;
  }

  .popup-item {
    padding: 5px 10px;
    font-size: 12px;
    /* A path or a long description must not wrap the row into two lines. */
    min-width: 0;
  }

  .popup-item-icon {
    flex: 0 0 auto;
    font-size: 13px;
  }

  .popup-item-label {
    flex: 0 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .autocomplete-item-detail {
    flex: 0 1 auto;
    margin-left: auto;
    padding-left: 12px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.8;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    /* The label is the thing being matched — it wins the space. */
    direction: rtl;
    text-align: right;
  }

  .autocomplete-empty {
    padding: 6px 10px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }
`;
