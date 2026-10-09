import mongoose, { Schema, Document } from "mongoose";

export interface IIdentityVerification extends Document {
    user: mongoose.Types.ObjectId;
    status: 'pending' | 'approved' | 'rejected';
    documentType: 'id_card' | 'passport' | 'driver_license';
    documentReferenceId: string;
    submittedAt: Date;
    consentGivenAt?: Date;
    processedAt?: Date;
    processedBy?: mongoose.Types.ObjectId;
    rejectionReason?: string;
    expiresAt: Date;
}

const IIdentityVerificationSchema: Schema = new Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending'
    },
    documentType: {
        type: String,
        enum: ['id_card', 'passport', 'driver_license'],
        required: true
    },
    documentReferenceId: {
        type: String,
        required: true
    },
    submittedAt: {
        type: Date,
        default: Date.now
    },
    // Preuve du consentement explicite (RGPD art. 7.1) donné au dépôt.
    consentGivenAt: Date,
    processedAt: Date,
    processedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    rejectionReason: String,
    expiresAt: {
        type: Date,
        required: true
    }
});

// Un seul dossier "pending" par utilisateur. L'ancien index incluait `expiresAt`
// (calculé à la milliseconde près par requête), donc deux soumissions quasi
// simultanées passaient toutes les deux le contrôle d'unicité et créaient
// chacune une alerte Discord distincte pour le même utilisateur.
IIdentityVerificationSchema.index({ user: 1 }, { unique: true, partialFilterExpression: { status: 'pending' } });
// Expiration des dossiers en attente (tâche de nettoyage) et file d'attente admin par statut.
IIdentityVerificationSchema.index({ status: 1, expiresAt: 1 });

export default (mongoose.models.IIdentityVerification as mongoose.Model<IIdentityVerification>) || mongoose.model<IIdentityVerification>('IIdentityVerification', IIdentityVerificationSchema);