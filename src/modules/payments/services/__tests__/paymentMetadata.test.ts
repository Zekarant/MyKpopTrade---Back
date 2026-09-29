process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-of-32-chars!';

import mongoose from 'mongoose';
import { EncryptionService } from '../../../../commons/utils/encryptionService';
import { decryptPaymentMetadata } from '../paymentService';

describe('decryptPaymentMetadata', () => {
  it('déchiffre les métadonnées : decrypt() rend déjà le JSON parsé', () => {
    // Régression : un JSON.parse supplémentaire recevait un objet, parsait
    // « [object Object] » et levait, si bien que rien n'était jamais déchiffré.
    const metadata = { orderRef: 'CMD-42', source: 'cart' };
    const paymentObj: { paymentMetadata?: string; metadata?: unknown } = {
      paymentMetadata: EncryptionService.encrypt(metadata)
    };

    decryptPaymentMetadata(paymentObj, new mongoose.Types.ObjectId());

    expect(paymentObj.metadata).toEqual(metadata);
    expect(paymentObj.paymentMetadata).toBeUndefined();
  });

  it('ne fait rien sans métadonnées chiffrées', () => {
    const paymentObj: { paymentMetadata?: string; metadata?: unknown } = {};

    decryptPaymentMetadata(paymentObj, new mongoose.Types.ObjectId());

    expect(paymentObj).toEqual({});
  });
});
