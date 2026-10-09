export interface ShutdownLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface ShutdownOptions {
  /** Plus aucune tâche planifiée ne doit démarrer pendant l'arrêt. */
  stopScheduledTasks: () => Promise<void>;
  /** Refuse les nouvelles connexions et attend la fin des requêtes en cours. */
  closeServer: () => Promise<void>;
  /** En dernier : les requêtes en cours ont encore besoin de la base. */
  disconnectDatabase: () => Promise<void>;
  exit: (code: number) => void;
  logger: ShutdownLogger;
  /** Au-delà, sortie forcée en échec. */
  timeoutMs: number;
}

/**
 * Construit le gestionnaire d'arrêt propre (SIGTERM / SIGINT).
 *
 * Un orchestrateur (Docker, Kubernetes, Render...) envoie SIGTERM avant de tuer
 * le conteneur : sans ce gestionnaire, les requêtes en cours sont coupées et
 * les écritures Mongo interrompues. Le délai de sécurité garantit qu'une étape
 * bloquée (requête interminable, Mongo injoignable) n'empêche pas la sortie.
 * Les signaux reçus pendant l'arrêt sont ignorés.
 */
export function createShutdownHandler(options: ShutdownOptions): (signal: string) => Promise<void> {
  const { stopScheduledTasks, closeServer, disconnectDatabase, exit, logger, timeoutMs } = options;
  let isShuttingDown = false;

  return async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info('Arrêt demandé, fermeture en cours', { signal });

    const forceExitTimer = setTimeout(() => {
      logger.error('Arrêt forcé : délai de fermeture dépassé', { timeoutMs });
      exit(1);
    }, timeoutMs);
    // Le minuteur seul ne doit pas maintenir le process en vie.
    forceExitTimer.unref();

    try {
      await stopScheduledTasks();
      await closeServer();
      await disconnectDatabase();
      clearTimeout(forceExitTimer);
      logger.info('Arrêt terminé');
      exit(0);
    } catch (error) {
      clearTimeout(forceExitTimer);
      logger.error('Échec de l\'arrêt propre', {
        error: error instanceof Error ? error.stack : String(error)
      });
      exit(1);
    }
  };
}
