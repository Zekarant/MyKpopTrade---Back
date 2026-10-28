import { AsyncLocalStorage } from 'async_hooks';

interface RequestContext {
  requestId: string;
}

/**
 * Contexte propre à une requête HTTP, propagé à travers les appels asynchrones.
 * Permet au logger d'ajouter l'identifiant de requête à chaque ligne sans
 * le faire passer en paramètre dans toutes les couches.
 */
const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/** Exécute `callback` (et tout ce qu'il déclenche en asynchrone) dans le contexte de la requête. */
export function runWithRequestId<T>(requestId: string, callback: () => T): T {
  return requestContextStorage.run({ requestId }, callback);
}

/** Identifiant de la requête en cours, ou undefined hors requête (tâche CRON, démarrage...). */
export function getRequestId(): string | undefined {
  return requestContextStorage.getStore()?.requestId;
}
