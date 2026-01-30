/**
 * Snapshot tests for DiffActor
 * Captures rendered output for visual regression detection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { DiffActor } from '../../../media/actors/diff/DiffActor';

describe('DiffActor Snapshots', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: DiffActor;

  beforeEach(() => {
    DiffActor.resetStylesInjected();

    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'diff-container';
    document.body.appendChild(element);

    actor = new DiffActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  describe('diff rendering', () => {
    it('renders simple addition diff', () => {
      actor.showDiff(
        'block-1',
        'test.ts',
        'const x = 1;',
        'const x = 1;\nconst y = 2;'
      );

      expect(element.innerHTML).toMatchSnapshot();
    });

    it('renders simple removal diff', () => {
      actor.showDiff(
        'block-1',
        'test.ts',
        'const x = 1;\nconst y = 2;',
        'const x = 1;'
      );

      expect(element.innerHTML).toMatchSnapshot();
    });

    it('renders modification diff', () => {
      actor.showDiff(
        'block-1',
        'test.ts',
        'const x = 1;\nconst y = 2;\nconst z = 3;',
        'const x = 1;\nconst y = 20;\nconst z = 3;'
      );

      expect(element.innerHTML).toMatchSnapshot();
    });

    it('renders multi-line diff with context', () => {
      actor.showDiff(
        'block-1',
        'src/utils/helper.ts',
        `function add(a, b) {
  return a + b;
}

function subtract(a, b) {
  return a - b;
}`,
        `function add(a, b) {
  // Add two numbers
  return a + b;
}

function subtract(a, b) {
  // Subtract two numbers
  return a - b;
}

function multiply(a, b) {
  return a * b;
}`
      );

      expect(element.innerHTML).toMatchSnapshot();
    });

    it('renders empty old content (new file)', () => {
      actor.showDiff(
        'block-1',
        'new-file.ts',
        '',
        'export const VERSION = "1.0.0";'
      );

      expect(element.innerHTML).toMatchSnapshot();
    });

    it('renders empty new content (file deletion)', () => {
      actor.showDiff(
        'block-1',
        'old-file.ts',
        'export const DEPRECATED = true;',
        ''
      );

      expect(element.innerHTML).toMatchSnapshot();
    });
  });

  describe('code samples', () => {
    it('renders TypeScript code diff', () => {
      actor.showDiff(
        'block-1',
        'types.ts',
        `interface User {
  name: string;
  email: string;
}`,
        `interface User {
  id: number;
  name: string;
  email: string;
  createdAt: Date;
}`
      );

      expect(element.innerHTML).toMatchSnapshot();
    });

    it('renders function modification diff', () => {
      actor.showDiff(
        'block-1',
        'api.ts',
        `async function fetchData(url: string) {
  const response = await fetch(url);
  return response.json();
}`,
        `async function fetchData(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error('Request failed');
  }
  return response.json();
}`
      );

      expect(element.innerHTML).toMatchSnapshot();
    });
  });

  describe('special characters', () => {
    it('renders HTML entities safely', () => {
      actor.showDiff(
        'block-1',
        'template.html',
        '<div class="old">',
        '<div class="new">'
      );

      expect(element.innerHTML).toMatchSnapshot();
    });

    it('renders code with special characters', () => {
      actor.showDiff(
        'block-1',
        'regex.ts',
        'const pattern = /\\d+/;',
        'const pattern = /\\d+\\.\\d+/;'
      );

      expect(element.innerHTML).toMatchSnapshot();
    });
  });

  describe('empty state', () => {
    it('renders empty when inactive', () => {
      expect(element.innerHTML).toMatchSnapshot();
    });

    it('renders empty after close', () => {
      actor.showDiff('block-1', 'test.ts', 'old', 'new');
      actor.close();

      expect(element.innerHTML).toMatchSnapshot();
    });
  });

  describe('injected styles', () => {
    it('injects styles into document head', () => {
      const styleTag = document.querySelector('style[data-actor="diff"]');
      expect(styleTag).toBeTruthy();
      expect(styleTag?.textContent).toMatchSnapshot();
    });
  });
});

describe('DiffActor State Snapshots', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: DiffActor;

  beforeEach(() => {
    DiffActor.resetStylesInjected();
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'diff-container';
    document.body.appendChild(element);
    actor = new DiffActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  it('captures initial state', () => {
    expect(actor.getState()).toMatchSnapshot();
  });

  it('captures active state', () => {
    actor.showDiff('block-1', 'test.ts', 'old', 'new');
    expect(actor.getState()).toMatchSnapshot();
  });

  it('captures state after close', () => {
    actor.showDiff('block-1', 'test.ts', 'old', 'new');
    actor.close();
    expect(actor.getState()).toMatchSnapshot();
  });
});
