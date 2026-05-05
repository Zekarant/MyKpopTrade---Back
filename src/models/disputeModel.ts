import mongoose, { Schema, Document } from 'mongoose';

/**
 * Litige (« dispute ») ouvert par un acheteur ou un vendeur sur un
 * paiement. Cycle de vie :
 *
 *   opened → under_review → (resolved | refunded | rejected | cancelled)
 *
 * Un seul litige actif par paiement à la fois (index partiel) — un nouveau
 * litige n'est créable qu'une fois le précédent clôturé.
 */
export type DisputeStatus =
  | 'opened'         // Litige ouvert, en attente de réponse de l'autre partie
  | 'under_review'   // Pris en charge par l'admin
  | 'resolved'       // Résolu en faveur du seller (paiement libéré)
  | 'refunded'       // Résolu en faveur du buyer (remboursement)
  | 'rejected'       // Rejeté (manque de preuves, hors périmètre…)
  | 'cancelled';     // Retiré par le plaignant

export type DisputeReason =
  | 'not_received'           // Colis jamais arrivé
  | 'damaged'                // Colis endommagé
  | 'not_as_described'       // Produit non conforme
  | 'counterfeit'            // Contrefaçon
  | 'wrong_item'             // Mauvais produit envoyé
  | 'partial_delivery'       // Livraison partielle
  | 'seller_unresponsive'    // Vendeur ne répond pas
  | 'buyer_abuse'            // Litige ouvert par le vendeur (abus acheteur)
  | 'other';

export interface IDisputeMessage {
  author: mongoose.Types.ObjectId;
  authorRole: 'buyer' | 'seller' | 'admin';
  content: string;
  attachments?: string[];
  createdAt: Date;
}

export interface IDispute extends Document {
  payment: mongoose.Types.ObjectId;
  buyer: mongoose.Types.ObjectId;
  seller: mongoose.Types.ObjectId;
  openedBy: mongoose.Types.ObjectId;
  openedByRole: 'buyer' | 'seller';
  reason: DisputeReason;
  description: string;
  status: DisputeStatus;
  evidence: string[];
  messages: IDisputeMessage[];
  resolution?: {
    decidedBy: mongoose.Types.ObjectId;
    decidedAt: Date;
    outcome: DisputeStatus;
    notes?: string;
    refundAmount?: number;
  };
  closedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const DisputeMessageSchema = new Schema<IDisputeMessage>({
  author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  authorRole: { type: String, enum: ['buyer', 'seller', 'admin'], required: true },
  content: { type: String, required: true, trim: true, maxlength: 2000 },
  attachments: [{ type: String, maxlength: 500 }],
  createdAt: { type: Date, default: Date.now }
}, { _id: false });

const DisputeSchema: Schema = new Schema({
  payment: {
    type: Schema.Types.ObjectId,
    ref: 'Payment',
    required: true,
    index: true
  },
  buyer: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  seller: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  openedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  openedByRole: { type: String, enum: ['buyer', 'seller'], required: true },
  reason: {
    type: String,
    enum: [
      'not_received', 'damaged', 'not_as_described', 'counterfeit',
      'wrong_item', 'partial_delivery', 'seller_unresponsive',
      'buyer_abuse', 'other'
    ],
    required: true
  },
  description: { type: String, required: true, trim: true, maxlength: 2000 },
  status: {
    type: String,
    enum: ['opened', 'under_review', 'resolved', 'refunded', 'rejected', 'cancelled'],
    default: 'opened',
    index: true
  },
  evidence: [{ type: String, maxlength: 500 }],
  messages: { type: [DisputeMessageSchema], default: [] },
  resolution: {
    type: new Schema({
      decidedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
      decidedAt: { type: Date, required: true },
      outcome: { type: String, required: true },
      notes: { type: String, maxlength: 2000 },
      refundAmount: { type: Number, min: 0 }
    }, { _id: false }),
    default: undefined
  },
  closedAt: { type: Date }
}, { timestamps: true });

// Index partiel : un seul litige actif par paiement
DisputeSchema.index(
  { payment: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['opened', 'under_review'] } } }
);

export default mongoose.models.Dispute || mongoose.model<IDispute>('Dispute', DisputeSchema);
