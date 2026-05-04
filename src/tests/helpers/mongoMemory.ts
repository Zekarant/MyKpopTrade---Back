import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongoServer: MongoMemoryServer | null = null;

/**
 * Démarre un MongoDB en mémoire et connecte mongoose dessus.
 * À appeler dans beforeAll de chaque test suite qui touche la DB.
 */
export async function startInMemoryMongo(): Promise<void> {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
}

/**
 * Déconnecte mongoose et arrête le serveur en mémoire.
 * À appeler dans afterAll.
 */
export async function stopInMemoryMongo(): Promise<void> {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
    mongoServer = null;
  }
}

/**
 * Vide toutes les collections. À appeler dans beforeEach pour isoler les tests.
 */
export async function clearAllCollections(): Promise<void> {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
}
