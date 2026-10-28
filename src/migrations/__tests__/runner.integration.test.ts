import mongoose from 'mongoose';
import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../tests/helpers/mongoMemory';
import { MIGRATIONS_COLLECTION, runMigrations, type Migration } from '../runner';

/** Runner : chaque migration une seule fois, dans l'ordre, et rien d'enregistré si elle échoue. */
const migrationNamed = (id: string, up: () => Promise<void> = async () => {}): Migration => ({
  id,
  description: `migration ${id}`,
  up: jest.fn(up)
});

const journal = () => mongoose.connection.collection(MIGRATIONS_COLLECTION);

describe('runMigrations (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  it('applique les migrations dans l\'ordre puis ne les rejoue plus', async () => {
    const order: string[] = [];
    const migrations = ['0001-a', '0002-b'].map((id) => migrationNamed(id, async () => { order.push(id); }));

    const first = await runMigrations(migrations);
    const second = await runMigrations(migrations);

    expect(first).toEqual(['0001-a', '0002-b']);
    expect(order).toEqual(['0001-a', '0002-b']);
    expect(second).toEqual([]);
    expect(await journal().countDocuments()).toBe(2);
  });

  it('applique seulement une migration ajoutée depuis le dernier lancement', async () => {
    const old = migrationNamed('0001-a');
    await runMigrations([old]);
    const added = migrationNamed('0002-b');

    expect(await runMigrations([old, added])).toEqual(['0002-b']);
    expect(old.up).toHaveBeenCalledTimes(1);
  });

  it('s\'arrête sur un échec sans l\'enregistrer, et la rejoue au lancement suivant', async () => {
    const failing = migrationNamed('0001-a', async () => { throw new Error('index en conflit'); });
    const next = migrationNamed('0002-b');

    await expect(runMigrations([failing, next])).rejects.toThrow('index en conflit');

    expect(next.up).not.toHaveBeenCalled();
    expect(await journal().countDocuments()).toBe(0);
  });

  it('ne fait pas échouer un lancement concurrent qui a déjà inscrit la migration', async () => {
    // L'autre déploiement inscrit la migration pendant que celui-ci la joue.
    const concurrent = migrationNamed('0001-a', async () => {
      await journal().insertOne({ _id: '0001-a' as never, description: 'autre lancement', appliedAt: new Date() });
    });

    await expect(runMigrations([concurrent])).resolves.toEqual([]);
    expect(await journal().countDocuments()).toBe(1);
  });

  it('refuse une liste mal ordonnée avant de toucher à la base', async () => {
    const second = migrationNamed('0002-b');
    const first = migrationNamed('0001-a');

    await expect(runMigrations([second, first])).rejects.toThrow('mal ordonnées');
    expect(second.up).not.toHaveBeenCalled();
  });
});
