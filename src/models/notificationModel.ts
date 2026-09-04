import mongoose, { Schema, Document } from "mongoose";

export interface INotification extends Document {
    recipient: mongoose.Types.ObjectId;
    type: string;
    title: string;
    content: string;
    link?: string;
    isRead: boolean;
    data?: any;
    expiresAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}

const NotificationSchema: Schema = new Schema({
    recipient: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    type: {
        type: String,
        required: true,
        enum: [
            'message',
            'offer',
            'counter_offer',
            'offer_accepted',
            'offer_rejected',
            'product_sold',
            'order_status',
            'system',
            'rating_received',
            'new_follower',
            'refund_issued',
            'refund_pending',
            'wishlist_price_drop',
            'wishlist_unavailable',
            'dispute_opened',
            'dispute_message',
            'dispute_resolved',
            'admin_alert'
        ]
    },
    title: {
        type: String,
        required: true
    },
    content: {
        type: String,
        required: true
    },
    link: {
        type: String,
        default: null
    },
    isRead: {
        type: Boolean,
        default: false
    },
    data: {
        type: Schema.Types.Mixed,
        default: null
    },
    expiresAt: {
        type: Date
    }
}, { timestamps: true });

NotificationSchema.index({ recipient: 1, isRead: 1 });
NotificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
NotificationSchema.index({ recipient: 1, createdAt: -1 });

export default mongoose.models.Notification || mongoose.model<INotification>('Notification', NotificationSchema);