/**
 * Tests for FilesShadowActor
 *
 * Tests the Shadow DOM modal for file selection including:
 * - Modal open/close behavior
 * - Open files display
 * - File search functionality
 * - Selected files management
 * - File content handling
 * - Pub/sub integration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FilesShadowActor, FileData } from '../../../media/actors/files/FilesShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';

// Mock VSCode API
const createMockVSCode = () => ({
  postMessage: vi.fn()
});

// Helper to wait for microtask
const waitForMicrotask = () => new Promise(resolve => queueMicrotask(resolve));

describe('FilesShadowActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: FilesShadowActor;
  let mockVSCode: ReturnType<typeof createMockVSCode>;

  beforeEach(() => {
    manager = new EventStateManager({ batchBroadcasts: false });
    element = document.createElement('div');
    element.id = 'files-container';
    document.body.appendChild(element);
    mockVSCode = createMockVSCode();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  describe('Shadow DOM creation', () => {
    it('creates shadow root on construction', () => {
      actor = new FilesShadowActor(manager, element, mockVSCode);

      expect(element.shadowRoot).toBeTruthy();
    });

    it('adopts stylesheets into shadow root', () => {
      actor = new FilesShadowActor(manager, element, mockVSCode);

      const sheets = element.shadowRoot?.adoptedStyleSheets;
      expect(sheets?.length).toBeGreaterThan(0);
    });

    it('renders modal structure', () => {
      actor = new FilesShadowActor(manager, element, mockVSCode);

      const backdrop = element.shadowRoot?.querySelector('.modal-backdrop');
      const modal = element.shadowRoot?.querySelector('.modal-container');
      const header = element.shadowRoot?.querySelector('.modal-header');
      const body = element.shadowRoot?.querySelector('.modal-body');
      const footer = element.shadowRoot?.querySelector('.modal-footer');

      expect(backdrop).toBeTruthy();
      expect(modal).toBeTruthy();
      expect(header).toBeTruthy();
      expect(body).toBeTruthy();
      expect(footer).toBeTruthy();
    });
  });

  describe('Modal visibility', () => {
    beforeEach(() => {
      actor = new FilesShadowActor(manager, element, mockVSCode);
    });

    it('starts hidden', () => {
      expect(actor.isVisible()).toBe(false);
    });

    it('opens when open() is called', () => {
      actor.open();

      expect(actor.isVisible()).toBe(true);
    });

    it('closes when close() is called', () => {
      actor.open();
      actor.close();

      expect(actor.isVisible()).toBe(false);
    });

    it('opens when files.modal.open is published', () => {
      manager.publishDirect('files.modal.open', true);

      expect(actor.isVisible()).toBe(true);
    });

    it('closes on Escape key', () => {
      actor.open();

      const event = new KeyboardEvent('keydown', { key: 'Escape' });
      document.dispatchEvent(event);

      expect(actor.isVisible()).toBe(false);
    });

    it('requests open files on modal open', () => {
      actor.open();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({ type: 'getOpenFiles' });
    });

    it('notifies extension on modal open', () => {
      actor.open();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({ type: 'fileModalOpened' });
    });

    it('notifies extension on modal close', () => {
      actor.open();
      mockVSCode.postMessage.mockClear();
      actor.close();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({ type: 'fileModalClosed' });
    });
  });

  describe('Open files display', () => {
    beforeEach(() => {
      actor = new FilesShadowActor(manager, element, mockVSCode);
      actor.open();
    });

    it('displays empty state when no files', () => {
      manager.publishDirect('files.openFiles', []);

      const emptyState = element.shadowRoot?.querySelector('.file-search-no-results');
      expect(emptyState?.textContent).toContain('No files currently open');
    });

    it('displays open files when provided', () => {
      manager.publishDirect('files.openFiles', ['src/app.ts', 'src/utils.ts']);

      const fileItems = element.shadowRoot?.querySelectorAll('.open-file-item');
      expect(fileItems?.length).toBe(2);
    });

    it('shows file path in item', () => {
      manager.publishDirect('files.openFiles', ['src/components/Button.tsx']);

      const fileName = element.shadowRoot?.querySelector('.open-file-name');
      expect(fileName?.textContent).toBe('src/components/Button.tsx');
    });

    it('updates open files count', () => {
      manager.publishDirect('files.openFiles', ['a.ts', 'b.ts', 'c.ts']);

      const count = element.shadowRoot?.querySelector('[data-open-count]');
      expect(count?.textContent).toBe('3');
    });
  });

  describe('File selection', () => {
    beforeEach(() => {
      actor = new FilesShadowActor(manager, element, mockVSCode);
      actor.open();
      mockVSCode.postMessage.mockClear();
    });

    it('requests file content when checkbox is checked', () => {
      // Publish open files within the test
      manager.publishDirect('files.openFiles', ['src/test.ts']);

      // Verify the open files list was rendered
      const fileItem = element.shadowRoot?.querySelector('.open-file-item');
      expect(fileItem).toBeTruthy();

      const checkbox = element.shadowRoot?.querySelector('.open-file-checkbox') as HTMLInputElement;
      expect(checkbox).toBeTruthy();
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'getFileContent',
        filePath: 'src/test.ts'
      });
    });

    it('adds file to selection when content is received', () => {
      manager.publishDirect('files.content', { path: 'src/test.ts', content: 'const x = 1;' });

      expect(actor.getSelectedFiles().has('src/test.ts')).toBe(true);
    });

    it('removes file from selection when checkbox is unchecked', () => {
      // Publish open files and add a file
      manager.publishDirect('files.openFiles', ['src/test.ts']);
      manager.publishDirect('files.content', { path: 'src/test.ts', content: 'code' });

      // Verify the checkbox exists
      const fileItem = element.shadowRoot?.querySelector('.open-file-item');
      expect(fileItem).toBeTruthy();

      // Then uncheck
      const checkbox = element.shadowRoot?.querySelector('.open-file-checkbox') as HTMLInputElement;
      expect(checkbox).toBeTruthy();
      checkbox.checked = false;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));

      expect(actor.getSelectedFiles().has('src/test.ts')).toBe(false);
    });

    it('updates selected count when files are added', () => {
      manager.publishDirect('files.content', { path: 'a.ts', content: 'a' });
      manager.publishDirect('files.content', { path: 'b.ts', content: 'b' });

      const count = element.shadowRoot?.querySelector('[data-selected-count]');
      expect(count?.textContent).toBe('2');
    });

    it('shows selected file chips', () => {
      manager.publishDirect('files.content', { path: 'src/app.ts', content: 'code' });

      const chip = element.shadowRoot?.querySelector('.selected-file-chip');
      expect(chip).toBeTruthy();
    });
  });

  describe('File search', () => {
    beforeEach(async () => {
      vi.useFakeTimers();
      actor = new FilesShadowActor(manager, element, mockVSCode);
      actor.open();
      mockVSCode.postMessage.mockClear();
    });

    it('searches after debounce when typing', async () => {
      const searchInput = element.shadowRoot?.querySelector('[data-file-search]') as HTMLInputElement;
      searchInput.value = 'test';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));

      // Should not search immediately
      expect(mockVSCode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'searchFiles' }));

      // After debounce
      vi.advanceTimersByTime(350);
      expect(mockVSCode.postMessage).toHaveBeenCalledWith({ type: 'searchFiles', query: 'test' });
    });

    it('does not search for queries less than 2 chars', async () => {
      const searchInput = element.shadowRoot?.querySelector('[data-file-search]') as HTMLInputElement;
      searchInput.value = 'a';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));

      vi.advanceTimersByTime(350);
      expect(mockVSCode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'searchFiles' }));
    });

    it('displays search results', () => {
      vi.useRealTimers();
      manager.publishDirect('files.searchResults', ['found/file1.ts', 'found/file2.ts']);

      const results = element.shadowRoot?.querySelectorAll('.file-search-result-item');
      expect(results?.length).toBe(2);
    });

    it('shows no results message when empty', () => {
      vi.useRealTimers();
      manager.publishDirect('files.searchResults', []);

      // Query specifically within the search results container
      const searchResultsContainer = element.shadowRoot?.querySelector('[data-search-results]');
      const noResults = searchResultsContainer?.querySelector('.file-search-no-results');
      expect(noResults?.textContent).toContain('No files found');
    });
  });

  describe('Clear selection', () => {
    beforeEach(() => {
      actor = new FilesShadowActor(manager, element, mockVSCode);
      actor.open();
      manager.publishDirect('files.content', { path: 'test.ts', content: 'code' });
    });

    it('Clear button clears all selected files', () => {
      const clearBtn = element.shadowRoot?.querySelector('[data-action="clear"]') as HTMLElement;
      clearBtn?.click();

      expect(actor.getSelectedFiles().size).toBe(0);
    });

    it('Clear button is hidden when no files selected', () => {
      const clearBtn = element.shadowRoot?.querySelector('[data-action="clear"]') as HTMLElement;
      clearBtn?.click();

      expect(clearBtn?.style.display).toBe('none');
    });
  });

  describe('Public API', () => {
    beforeEach(() => {
      actor = new FilesShadowActor(manager, element, mockVSCode);
    });

    it('getSelectedFiles() returns current selection', () => {
      actor.open();
      manager.publishDirect('files.content', { path: 'a.ts', content: 'a' });

      const selected = actor.getSelectedFiles();
      expect(selected.get('a.ts')).toBe('a');
    });

    it('clearSelection() clears all files', () => {
      actor.open();
      manager.publishDirect('files.content', { path: 'a.ts', content: 'a' });

      actor.clearSelection();

      expect(actor.getSelectedFiles().size).toBe(0);
    });

    it('getFileCount() returns count', () => {
      actor.open();
      manager.publishDirect('files.content', { path: 'a.ts', content: 'a' });
      manager.publishDirect('files.content', { path: 'b.ts', content: 'b' });

      expect(actor.getFileCount()).toBe(2);
    });

    it('onFilesChange() handler is called on commit', () => {
      const handler = vi.fn();
      actor.onFilesChange(handler);

      actor.open();
      manager.publishDirect('files.content', { path: 'test.ts', content: 'code' });

      const addBtn = element.shadowRoot?.querySelector('[data-action="add"]') as HTMLElement;
      addBtn?.click();

      expect(handler).toHaveBeenCalledWith([{ path: 'test.ts', content: 'code' }]);
    });
  });

  describe('Lifecycle', () => {
    it('cleans up on destroy', () => {
      actor = new FilesShadowActor(manager, element, mockVSCode);
      actor.open();

      actor.destroy();

      expect(() => actor.isVisible()).not.toThrow();
    });
  });
});
