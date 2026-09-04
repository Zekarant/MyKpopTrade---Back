import mongoose, { Schema, Document } from "mongoose";

export interface IIdentityVerification extends Document {
    user: mongoose.Types.ObjectId;
    status: 'pending' | 'approved' | 'rejected';
    document_type: 'id_card' | 'passport' | 'driver_license';
    documentReferenceId: string;
    submittedAt: Date;
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

export default mongoose.models.IIdentityVerification || mongoose.model<IIdentityVerification>('IIdentityVerification', IIdentityVerificationSchema);