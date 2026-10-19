// EngineManager.getApiGateway(): the seam the local gateway uses to enforce
// API keys. It must never throw — before start, after stop or mid-reset it
// answers undefined, which the gateway turns into a 403 rather than a 500.

import { EngineManager } from '../../../src/server/engine/engine-manager.js';

describe('EngineManager.getApiGateway', () => {
  const manager = EngineManager.getInstance() as unknown as { backend: unknown };
  let saved: unknown;

  beforeEach(() => {
    saved = manager.backend;
  });

  afterEach(() => {
    manager.backend = saved;
  });

  it('is undefined while no backend exists', () => {
    manager.backend = null;
    expect(EngineManager.getInstance().getApiGateway()).toBeUndefined();
  });

  it('is undefined while the backend is not running', () => {
    const getApiGateway = jest.fn();
    manager.backend = { isRunning: () => false, getApiGateway };
    expect(EngineManager.getInstance().getApiGateway()).toBeUndefined();
    expect(getApiGateway).not.toHaveBeenCalled();
  });

  it('swallows a backend that throws mid-reset', () => {
    manager.backend = {
      isRunning: () => true,
      getApiGateway: () => {
        throw new Error('The self engine is not running');
      },
    };
    expect(EngineManager.getInstance().getApiGateway()).toBeUndefined();
  });

  it('hands back the running emulator', () => {
    const emulator = { resolveApiKeyByValue: jest.fn() };
    manager.backend = { isRunning: () => true, getApiGateway: () => emulator };
    expect(EngineManager.getInstance().getApiGateway()).toBe(emulator);
  });
});
