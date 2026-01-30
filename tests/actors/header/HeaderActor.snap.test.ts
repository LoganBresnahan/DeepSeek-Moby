/**
 * Snapshot tests for HeaderActor
 * Captures DOM output for visual regression detection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { HeaderActor } from '../../../media/actors/header/HeaderActor';

describe('HeaderActor Snapshots', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: HeaderActor;

  beforeEach(() => {
    HeaderActor.resetStylesInjected();

    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'chat-header';
    document.body.appendChild(element);

    actor = new HeaderActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  describe('initial state', () => {
    it('renders header with default values', () => {
      expect(element.innerHTML).toMatchSnapshot();
    });
  });

  describe('with custom title', () => {
    it('renders header with custom title', () => {
      actor.setTitle('My Coding Session');
      expect(element.innerHTML).toMatchSnapshot();
    });
  });

  describe('with different model', () => {
    it('renders header with reasoner model', () => {
      actor.setModel('deepseek-reasoner');
      expect(element.innerHTML).toMatchSnapshot();
    });
  });

  describe('injected styles', () => {
    it('injects styles into document head', () => {
      const styleTag = document.querySelector('style[data-actor="header"]');
      expect(styleTag).toBeTruthy();
      expect(styleTag?.textContent).toMatchSnapshot();
    });
  });
});

describe('HeaderActor State Snapshots', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: HeaderActor;

  beforeEach(() => {
    HeaderActor.resetStylesInjected();
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'chat-header';
    document.body.appendChild(element);
    actor = new HeaderActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  it('captures initial state', () => {
    expect(actor.getState()).toMatchSnapshot();
  });

  it('captures state with menu open', () => {
    const menuBtn = element.querySelector('.header-menu-toggle') as HTMLButtonElement;
    menuBtn.click();
    expect(actor.getState()).toMatchSnapshot();
  });
});
