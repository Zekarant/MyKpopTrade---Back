import { Schema, model } from 'mongoose';

interface IUserEmail {
    email: string;
    createdAt?: Date;
}

const UserSchema = new Schema < IUserEmail > ({
    email: {
        type: String,
        required: true,
        unique: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

export default model < IUserEmail > ('UserEmail', UserSchema);