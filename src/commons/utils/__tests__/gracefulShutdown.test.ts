import { createShutdownHandler, ShutdownOptions } from '../gracefulShutdown';

const TIMEOUT_MS = 10_000;

/** Étapes factices qui enregistrent leur ordre d'appel. */
function aShutdown(overrides: Partial<ShutdownOptions> = {}) {
  const calls: string[] = [];
  const exit = jest.fn((code: number) => { calls.push(`exit:${code}`); });
  const options: ShutdownOptions = {
    stopScheduledTasks: async () => { calls.push('cron'); },
    closeServer: async () => { calls.push('server'); },
    disconnectDatabase: async () => { calls.push('database'); },
    exit,
    logger: { info: jest.fn(), error: jest.fn() },
    timeoutMs: TIMEOUT_MS,
    ...overrides
  };
  return { shutdown: createShutdownHandler(options), calls, exit };
}

describe('createShutdownHandler', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('arrête les tâches, puis le serveur, puis la base, et sort en succès', async () => {
    const { shutdown, calls } = aShutdown();

    await shutdown('SIGTERM');

    expect(calls).toEqual(['cron', 'server', 'database', 'exit:0']);
  });

  it('ignore un second signal reçu pendant l\'arrêt', async () => {
    const { shutdown, calls } = aShutdown();

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    expect(calls).toEqual(['cron', 'server', 'database', 'exit:0']);
  });

  it('sort en échec si une étape échoue, sans couper la base', async () => {
    const { shutdown, calls } = aShutdown({
      closeServer: async () => { throw new Error('close impossible'); }
    });

    await shutdown('SIGTERM');

    expect(calls).toEqual(['cron', 'exit:1']);
  });

  it('force la sortie en échec si une étape ne rend jamais la main', async () => {
    jest.useFakeTimers();
    const { shutdown, exit } = aShutdown({
      closeServer: () => new Promise<void>(() => { /* requête interminable */ })
    });

    void shutdown('SIGTERM');
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(exit).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('n\'arme pas de sortie forcée après un arrêt réussi', async () => {
    jest.useFakeTimers();
    const { shutdown, exit } = aShutdown();

    await shutdown('SIGTERM');
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS * 2);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
