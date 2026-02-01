/**
 * Snapshot tests for InputActor
 * Captures DOM output for visual regression detection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { InputActor } from '../../../media/actors/input/InputActor';

describe('InputActor Snapshots', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: InputActor;

  beforeEach(() => {
    InputActor.resetStylesInjected();

    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'chat-input';
    document.body.appendChild(element);

    actor = new InputActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  describe('initial state', () => {
    it('renders empty input', () => {
      expect(element.innerHTML).toMatchSnapshot();
    });
  });

  describe('with content', () => {
    it('renders input with value', () => {
      actor.setValue('Hello, how can I help you?');
      expect(element.innerHTML).toMatchSnapshot();
    });

    it('renders input with file attachments', () => {
      actor.addFile('/workspace/src/main.ts');
      actor.addFile('/workspace/package.json');
      expect(element.innerHTML).toMatchSnapshot();
    });

    it('renders input with value and files', () => {
      actor.setValue('Please review this code');
      actor.addFile('/workspace/src/utils.ts');
      expect(element.innerHTML).toMatchSnapshot();
    });
  });

  describe('injected styles', () => {
    it('injects styles into document head', () => {
      const styleTag = document.querySelector('style[data-actor="input"]');
      expect(styleTag).toBeTruthy();
      expect(styleTag?.textContent).toMatchSnapshot();
    });
  });
});

describe('InputActor State Snapshots', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: InputActor;

  beforeEach(() => {
    InputActor.resetStylesInjected();
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'chat-input';
    document.body.appendChild(element);
    actor = new InputActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  it('captures initial state', () => {
    expect(actor.getState()).toMatchSnapshot();
  });

  it('captures state with value', () => {
    actor.setValue('Test message');
    expect(actor.getState()).toMatchSnapshot();
  });

  it('captures state with files', () => {
    actor.addFile('/path/to/file.txt');
    actor.addFile('/another/file.js');
    expect(actor.getState()).toMatchSnapshot();
  });
});
