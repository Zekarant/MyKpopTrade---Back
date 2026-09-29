import mongoose from 'mongoose';
import Message, { IMessage } from '../../../models/messageModel';
import Conversation from '../../../models/conversationModel';
import logger from '../../../commons/utils/logger';

/**
 * Envoie un message dans une conversation
 */
export const sendMessage = async ({
  conversationId,
  senderId,
  content,
  attachments = [],
  contentType = 'text'
}: {
  conversationId: string | mongoose.Types.ObjectId;
  senderId: string;
  content: string;
  attachments?: string[];
  contentType?: IMessage['contentType'];
}) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Vérifier si l'expéditeur fait partie de la conversation
    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: senderId,
      status: 'open',
      isActive: true
    });

    if (!conversation) {
      throw new Error('Conversation non trouvée ou accès refusé');
    }

    const newMessage = await Message.create([{
      conversation: conversationId,
      sender: senderId,
      content,
      contentType,
      readBy: [senderId],
      ...(attachments.length > 0 ? { attachments } : {})
    }], { session });

    // Mettre à jour la date du dernier message dans la conversation
    await Conversation.updateOne(
      { _id: conversationId },
      { lastMessageAt: new Date() },
      { session }
    );

    await session.commitTransaction();

    return newMessage[0];
  } catch (error) {
    await session.abortTransaction();
    logger.error('Erreur lors de l\'envoi d\'un message', { error });
    throw error;
  } finally {
    session.endSession();
  }
};
