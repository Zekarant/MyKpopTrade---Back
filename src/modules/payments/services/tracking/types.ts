/**
 * Abstraction d'un fournisseur de tracking de colis.
 *
 * Implémente cette interface pour brancher un service externe
 * (AfterShip, EasyPost, La Poste, TrackingMore…). Le domaine ne
 * dépend que de cette interface — la concrétion est wirée au démarrage.
 */
export type TrackingEventStatus =
  | 'shipped'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'exception'
  | 'returned'
  | 'unknown';

export interface TrackingEvent {
  status: TrackingEventStatus;
  description?: string;
  location?: string;
  occurredAt: Date;
}

export interface TrackingResult {
  /** Dernier statut connu côté transporteur. */
  status: TrackingEventStatus;
  /** Date estimée de livraison si disponible. */
  estimatedDeliveryAt?: Date;
  /** Liste ordonnée d'événements (du plus ancien au plus récent). */
  events: TrackingEvent[];
}

export interface TrackingProvider {
  readonly name: string;
  /**
   * Renvoie l'état courant côté transporteur. Doit être idempotent et
   * tolérer un transporteur inconnu (renvoyer un résultat vide).
   */
  track(carrier: string, trackingNumber: string): Promise<TrackingResult>;
}
