import logger from '../../../../commons/utils/logger';
import { NoopTrackingProvider } from './noopProvider';
import { TrackingProvider } from './types';

let cached: TrackingProvider | null = null;

/**
 * Résout le provider de tracking à utiliser. La résolution est mémoïsée
 * pour éviter d'instancier le provider à chaque polling. Aujourd'hui,
 * seul le Noop provider est livré — un provider AfterShip / EasyPost /
 * La Poste pourra être ajouté ici sans toucher au domaine.
 */
export function getTrackingProvider(): TrackingProvider {
  if (cached) return cached;

  const configured = (process.env.TRACKING_PROVIDER || 'noop').toLowerCase();

  switch (configured) {
    case 'noop':
    case '':
      cached = new NoopTrackingProvider();
      break;
    default:
      logger.warn(`Provider de tracking inconnu '${configured}', fallback Noop`);
      cached = new NoopTrackingProvider();
  }

  return cached;
}

/** Réinitialise le cache (utile pour les tests). */
export function resetTrackingProviderCache(): void {
  cached = null;
}

export type { TrackingProvider, TrackingResult, TrackingEvent, TrackingEventStatus } from './types';
