/**
 * Scroll actor styles
 * Minimal CSS - scroll behavior is primarily JavaScript-driven
 */
export const scrollStyles = `
/* Scroll to bottom button */
.scroll-to-bottom {
  position: absolute;
  bottom: 80px;
  right: 20px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  opacity: 0;
  transform: translateY(10px);
  transition: opacity 0.2s ease, transform 0.2s ease;
  pointer-events: none;
  z-index: 100;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.scroll-to-bottom.visible {
  opacity: 1;
  transform: translateY(0);
  pointer-events: auto;
}

.scroll-to-bottom:hover {
  background: var(--vscode-button-hoverBackground);
}

.scroll-to-bottom::after {
  content: '↓';
}
`;
