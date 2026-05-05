import { TrackingProvider, TrackingResult } from './types';

/**
 * Provider par défaut : ne contacte aucun transporteur. Renvoie toujours
 * un résultat vide pour que le pipeline d'automatisation (cron, timeline,
 * relances) fonctionne sans dépendance externe. Sert de fallback tant
 * qu'un provider réel (AfterShip, La Poste, etc.) n'est pas configuré.
 */
export class NoopTrackingProvider implements TrackingProvider {
  readonly name = 'noop';

  async track(_carrier: string, _trackingNumber: string): Promise<TrackingResult> {
    return { status: 'unknown', events: [] };
  }
}
