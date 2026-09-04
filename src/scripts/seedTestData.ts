import mongoose from 'mongoose';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { createCanvas } from 'canvas';

import User from '../models/userModel';
import Product from '../models/productModel';
import Rating from '../models/ratingModel';
import KpopGroup from '../models/kpopGroupModel';
import Conversation from '../models/conversationModel';
import Message from '../models/messageModel';
import Post from '../modules/posts/model';
import Follow from '../modules/follows/model';

dotenv.config();

/**
 * Jeu de données de test : profils variés, annonces et publications crédibles.
 *
 * ⚠️ Développement uniquement. Le script refuse de tourner si NODE_ENV=production.
 *
 * Idempotent : il identifie SES PROPRES documents (users au domaine
 * `@seed.mkt.dev`, groupes tagués `seed`, et tout ce qui s'y rattache),
 * les supprime puis les recrée. Il ne touche jamais aux données réelles.
 *
 * Images : les annonces de type "photocard" utilisent les visuels fournis dans
 * `uploads/products/seed-pc-*.png` (groupes fictifs, aucun problème de droit
 * d'auteur). Tout le reste (albums, merch, avatars, bannières, groupes, posts)
 * est généré localement avec `canvas`.
 *
 * Usage : npx ts-node src/scripts/seedTestData.ts --yes
 */

// TLD volontairement en 3 lettres : le validateur e-mail du modèle User
// n'accepte que des extensions de 2 à 3 caractères.
const SEED_EMAIL_DOMAIN = 'seed.mkt.dev';
const SEED_PASSWORD = 'SeedPass123!';
const SEED_GROUP_TAG = 'seed';
const UPLOADS_ROOT = path.join(__dirname, '../../uploads');

// --- utilitaires ------------------------------------------------------------

/** Générateur pseudo-aléatoire déterministe (mulberry32) seedé par une chaîne. */
function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(arr: T[], r: () => number): T {
  return arr[Math.floor(r() * arr.length)];
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

/**
 * Génère une image placeholder (dégradé + texte) et l'écrit dans `uploads/<dir>`.
 * Retourne le chemin relatif tel que stocké en base (`/uploads/<dir>/<file>`).
 */
function makeImage(
  dir: string,
  filename: string,
  lines: string[],
  width: number,
  height: number
): string {
  const targetDir = path.join(UPLOADS_ROOT, dir);
  fs.mkdirSync(targetDir, { recursive: true });

  const r = rng(filename);
  const hue = Math.floor(r() * 360);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, `hsl(${hue}, 62%, 58%)`);
  gradient.addColorStop(1, `hsl(${(hue + 40) % 360}, 62%, 42%)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((line, i) => {
    ctx.font = `${i === 0 ? 'bold ' : ''}${i === 0 ? 30 : 22}px sans-serif`;
    ctx.fillText(line, width / 2, height / 2 + (i - (lines.length - 1) / 2) * 34);
  });

  fs.writeFileSync(path.join(targetDir, filename), canvas.toBuffer('image/png'));
  return `/uploads/${dir}/${filename}`;
}

// --- données de référence -------------------------------------------------

const GROUPS: { name: string; members: string[]; genres: string[]; albums: string[] }[] = [
  {
    name: 'ASTRAEA',
    members: ['Minji', 'Soori', 'Yerim', 'Haeun'],
    genres: ['K-pop', 'Pop'],
    albums: ['TWINKLE NIGHT', 'FANTASY TOUR', 'STARDUST DIARY']
  },
  {
    name: 'NEON',
    members: ['Juno', 'Sian', 'Doha', 'Ryu'],
    genres: ['K-pop', 'R&B'],
    albums: ['NEON PULSE', 'MIDNIGHT DRIVE', 'AFTERGLOW']
  },
  {
    name: 'AETHEL',
    members: ['Leo', 'Hwan', 'Taeyang', 'Rin'],
    genres: ['K-pop', 'Hip-hop'],
    albums: ['AETHEL : ORIGIN', 'AETHER RISING', 'UNIT COLORS']
  },
  {
    name: 'DREAMGIRL',
    members: ['Seoyoon', 'Nari', 'Chaeri', 'Boram'],
    genres: ['K-pop', 'Pop'],
    albums: ['GARDEN OF DREAMS', 'DREAMGIRL ALBUM', 'SWEET SIGNAL']
  },
  {
    name: 'NOVA',
    members: ['Kai', 'Jiho', 'Woosung', 'Siwoo'],
    genres: ['K-pop', 'Dance'],
    albums: ['STARGAZE', 'NOVA CITY', 'ECLIPSE']
  },
  {
    name: 'STARFALL',
    members: ['Yun', 'Dojin', 'Haru', 'Jaewon'],
    genres: ['K-pop', 'Pop'],
    albums: ['K-POP PRINCE', 'STARFALL DEBUT', 'WISHING WELL']
  },
  {
    name: 'LUNA',
    members: ['Minji', 'Yuri', 'Somin', 'Areum'],
    genres: ['K-pop', 'Dance'],
    albums: ['HAPPINESS!', 'MOONLIGHT DIARY', 'PHASE 1']
  }
];

/**
 * Photocards réelles (images fournies) utilisées en priorité pour les annonces
 * de type "photocard". Le reste des visuels (albums, merch, avatars, bannières,
 * groupes, posts) continue d'utiliser `makeImage()`.
 */
const PHOTOCARD_IMAGES: { group: string; member: string; file: string }[] = [
  { group: 'ASTRAEA', member: 'Minji', file: 'seed-pc-astraea-minji.png' },
  { group: 'ASTRAEA', member: 'Soori', file: 'seed-pc-astraea-soori.png' },
  { group: 'NEON', member: 'Juno', file: 'seed-pc-neon-juno.png' },
  { group: 'AETHEL', member: 'Leo', file: 'seed-pc-aethel-leo-hwan.png' },
  { group: 'AETHEL', member: 'Hwan', file: 'seed-pc-aethel-leo-hwan.png' },
  { group: 'DREAMGIRL', member: 'Seoyoon', file: 'seed-pc-dreamgirl-seoyoon.png' },
  { group: 'NOVA', member: 'Kai', file: 'seed-pc-nova-kai.png' },
  { group: 'STARFALL', member: 'Yun', file: 'seed-pc-starfall-yun.png' },
  { group: 'LUNA', member: 'Minji', file: 'seed-pc-luna-minji.png' }
];

/**
 * Choisit 1 à `count` images réelles de photocard pour un groupe/membre donné :
 * priorité à l'image du membre exact, sinon une autre image du même groupe.
 * Retourne un tableau vide si le groupe n'a aucune image réelle disponible.
 */
function pickPhotocardImages(groupName: string, member: string | undefined, count: number, r: () => number): string[] {
  const pool = PHOTOCARD_IMAGES.filter((p) => p.group === groupName);
  if (pool.length === 0) return [];

  const exact = pool.filter((p) => p.member === member);
  const rest = pool.filter((p) => !exact.includes(p));
  const ordered = exact.length > 0 ? [...exact, ...rest] : [...pool].sort(() => r() - 0.5);

  const files: string[] = [];
  for (const entry of ordered) {
    if (files.includes(entry.file)) continue;
    files.push(entry.file);
    if (files.length >= count) break;
  }
  return files.map((file) => `/uploads/products/${file}`);
}

interface PersonaSpec {
  username: string;
  bio: string;
  location?: string;
  role?: 'user' | 'admin';
  persona: 'admin' | 'power-seller' | 'casual-seller' | 'new' | 'buyer' | 'collector' | 'suspended' | 'leaving';
  paypal?: boolean;
  verified?: boolean;
  profileCompleted?: boolean;
  emailVerified?: boolean;
  accountStatus?: 'active' | 'suspended';
  isActive?: boolean;
  scheduledForDeletion?: boolean;
  memberSinceDays: number;
  avatarFile?: string;
  bannerFile?: string;
}

const PERSONAS: PersonaSpec[] = [
  {
    username: 'seed_admin', bio: 'Compte administrateur de test.', role: 'admin',
    persona: 'admin', verified: true, emailVerified: true, memberSinceDays: 800
  },
  {
    username: 'mina_collects', bio: 'Vendeuse depuis 2021 · envois sous 24h 📦 · Lyon',
    location: 'Lyon, France', persona: 'power-seller', paypal: true, verified: true,
    emailVerified: true, memberSinceDays: 640, avatarFile: 'seed-avatar-mina_collects-real.png',
    bannerFile: 'seed-banner-mina_collects-real.png'
  },
  {
    username: 'kpop_leo', bio: 'Je revends mes doubles de temps en temps, prix négociables.',
    location: 'Bruxelles, Belgique', persona: 'casual-seller', emailVerified: true, memberSinceDays: 300,
    avatarFile: 'seed-avatar-kpop_leo-real.png'
  },
  {
    username: 'sohee_x', bio: '', persona: 'new', profileCompleted: false,
    emailVerified: false, memberSinceDays: 2
  },
  {
    username: 'clara_wty', bio: 'Toujours à la recherche de photocards DREAMGIRL 🩵 wishlist en bio',
    location: 'Paris, France', persona: 'buyer', emailVerified: true, memberSinceDays: 210
  },
  {
    username: 'skz_archive', bio: 'NOVA & AETHEL · collection 400+ PC · trades ok',
    location: 'Nantes, France', persona: 'collector', emailVerified: true, memberSinceDays: 480
  },
  {
    username: 'old_trader99', bio: 'Compte suspendu (jeu de test modération).',
    persona: 'suspended', accountStatus: 'suspended', isActive: false, emailVerified: true,
    memberSinceDays: 720
  },
  {
    username: 'temp_account', bio: 'Compte marqué pour suppression (test RGPD).',
    persona: 'leaving', scheduledForDeletion: true, emailVerified: true, memberSinceDays: 90
  }
];

const CONDITIONS = ['new', 'likeNew', 'good', 'fair', 'poor'] as const;
const POST_TEXTS = [
  'Enfin arrivé mon pull set LUNA 🥹 la qualité est incroyable',
  'Quelqu\'un sait si les PC de la version Weverse STARGAZE sont plus rares ?',
  'Mail day 📬 3 semaines d\'attente mais ça valait le coup',
  'Je cherche à compléter ma collection Seoyoon, DM ouverts pour trades',
  'Rappel : vérifiez toujours les photos réelles avant d\'acheter une PC "rare"',
  'Petit unboxing du dernier album AETHEL, le photobook est magnifique',
  'Première vente sur MyKpopTrade, merci à l\'acheteuse pour la confiance 💜',
  'Les prix des STARFALL OT7 ont explosé depuis le comeback non ?',
  'Ma holo Hwan est enfin là, la collection AETHEL avance bien',
  'Astuce rangement : les classeurs A5 avec pochettes 4 cases c\'est parfait',
  'Comment vous protégez vos PC pour un envoi international ?',
  'Grosse maj de ma wishlist NOVA, on échange ?',
  'Reçu ma commande groupée, tout est nickel emballé 👌',
  'Je débute la collection, des conseils pour éviter les arnaques ?'
];

// --- seed ---------------------------------------------------------------------

async function purgePreviousSeed(): Promise<void> {
  const seededUsers = await User.find({ email: new RegExp(`@${SEED_EMAIL_DOMAIN.replace(/\./g, '\\.')}$`) })
    .select('_id')
    .lean();
  const userIds = seededUsers.map((u: any) => u._id);
  const seedConvoIds = await Conversation.find({ participants: { $in: userIds } }).distinct('_id');

  await Promise.all([
    Product.deleteMany({ seller: { $in: userIds } }),
    Post.deleteMany({ author: { $in: userIds } }),
    Rating.deleteMany({ $or: [{ reviewer: { $in: userIds } }, { recipient: { $in: userIds } }] }),
    Follow.deleteMany({ $or: [{ follower: { $in: userIds } }, { following: { $in: userIds } }] }),
    Message.deleteMany({ conversation: { $in: seedConvoIds } }),
    Conversation.deleteMany({ _id: { $in: seedConvoIds } }),
    KpopGroup.deleteMany({ tags: SEED_GROUP_TAG }),
    User.deleteMany({ _id: { $in: userIds } })
  ]);

  console.log(`Purge : ${userIds.length} comptes de seed précédents supprimés.`);
}

/**
 * Réutilise les groupes réels déjà présents en base (scrapés) et ne crée que
 * ceux qui manquent, tagués `seed` pour être purgeables.
 */
async function resolveGroups() {
  const resolved: any[] = [];
  let createdCount = 0;
  for (const g of GROUPS) {
    let doc = await KpopGroup.findOne({ name: g.name });
    if (!doc) {
      const slug = g.name.toLowerCase().replace(/[^a-z]/g, '');
      doc = await KpopGroup.create({
        name: g.name,
        profileImage: makeImage('profiles', `seed-group-${slug}.png`, [g.name], 400, 400),
        bannerImage: makeImage('banners', `seed-group-banner-${slug}.png`, [g.name], 1200, 400),
        genres: g.genres,
        tags: [SEED_GROUP_TAG, 'K-pop'],
        discoverySource: 'Manual',
        followers: [],
        followersCount: 0
      });
      createdCount++;
    }
    resolved.push(doc);
  }
  console.log(`Groupes : ${resolved.length} résolus (${createdCount} créés, ${resolved.length - createdCount} réutilisés).`);
  return resolved;
}

async function seedUsers() {
  const created: any[] = [];
  for (const spec of PERSONAS) {
    const email = `${spec.username}@${SEED_EMAIL_DOMAIN}`;
    const realAvatarPath = spec.avatarFile ? path.join(UPLOADS_ROOT, 'profiles', spec.avatarFile) : undefined;
    const profilePicture = realAvatarPath && fs.existsSync(realAvatarPath)
      ? `/uploads/profiles/${spec.avatarFile}`
      : makeImage('profiles', `seed-avatar-${spec.username}.png`, [spec.username], 400, 400);
    const realBannerPath = spec.bannerFile ? path.join(UPLOADS_ROOT, 'banners', spec.bannerFile) : undefined;
    const profileBanner = realBannerPath && fs.existsSync(realBannerPath)
      ? `/uploads/banners/${spec.bannerFile}`
      : spec.persona === 'new'
        ? null
        : makeImage('banners', `seed-banner-${spec.username}.png`, [spec.username], 1200, 400);

    const user = new User({
      username: spec.username,
      email,
      password: SEED_PASSWORD,
      role: spec.role ?? 'user',
      isActive: spec.isActive ?? true,
      profilePicture,
      profileBanner,
      bio: spec.bio,
      location: spec.location,
      accountStatus: spec.accountStatus ?? 'active',
      isEmailVerified: spec.emailVerified ?? false,
      profileCompleted: spec.profileCompleted ?? true,
      scheduledForDeletion: spec.scheduledForDeletion ?? false,
      scheduledDeletionDate: spec.scheduledForDeletion ? daysAgo(-15) : undefined,
      privacyPolicyAccepted: true,
      privacyPolicyAcceptedAt: daysAgo(spec.memberSinceDays),
      dataProcessingConsent: true,
      dataProcessingConsentAt: daysAgo(spec.memberSinceDays),
      marketingConsent: spec.persona === 'buyer' || spec.persona === 'collector',
      isSellerVerified: spec.verified ?? false,
      verificationLevel: spec.verified ? 'advanced' : 'none',
      isIdentityVerified: spec.verified ?? false,
      paypalConnected: spec.paypal ?? false,
      paypalEmail: spec.paypal ? email : undefined,
      paypalMerchantId: spec.paypal ? `SEED${spec.username.toUpperCase().replace(/[^A-Z0-9]/g, '')}` : undefined,
      paypalOnboarding: spec.paypal
        ? { paymentsReceivable: true, primaryEmailConfirmed: true, consentGranted: true, scopes: [], checkedAt: new Date(0) }
        : undefined,
      statistics: {
        totalSales: 0,
        totalPurchases: 0,
        totalListings: 0,
        memberSince: daysAgo(spec.memberSinceDays),
        lastActive: daysAgo(Math.floor(Math.random() * 10)),
        averageRating: 0,
        totalRatings: 0
      }
    });
    await user.save();
    created.push(user);
  }
  console.log(`Utilisateurs : ${created.length} créés (mot de passe commun : ${SEED_PASSWORD}).`);
  return created;
}

async function seedProducts(usersByName: Record<string, any>) {
  // Répartition des annonces par vendeur.
  const plan: { seller: string; count: number }[] = [
    { seller: 'mina_collects', count: 13 },
    { seller: 'kpop_leo', count: 6 },
    { seller: 'skz_archive', count: 6 },
    { seller: 'clara_wty', count: 3 },
    { seller: 'seed_admin', count: 2 }
  ];

  const buyers = ['clara_wty', 'skz_archive', 'kpop_leo'].map((n) => usersByName[n]);
  const products: any[] = [];

  for (const { seller, count } of plan) {
    const sellerDoc = usersByName[seller];
    for (let i = 0; i < count; i++) {
      const r = rng(`${seller}-${i}`);
      const group = pick(GROUPS, r);
      const member = pick(group.members, r);
      const isAlbum = r() < 0.18;
      const isMerch = !isAlbum && r() < 0.12;
      const type = isAlbum ? 'album' : isMerch ? 'merch' : 'photocard';
      const album = pick(group.albums, r);

      const title = type === 'photocard'
        ? `PC ${member} (${group.name}) — ${album}`
        : type === 'album'
          ? `Album ${group.name} — ${album} (version aléatoire)`
          : `Merch ${group.name} — lightstick / goodies`;

      const basePrice = type === 'photocard' ? 4 + Math.floor(r() * 38) : type === 'album' ? 16 + Math.floor(r() * 40) : 12 + Math.floor(r() * 55);
      const imageCount = 1 + Math.floor(r() * 2);
      const realPhotocardImages = type === 'photocard' ? pickPhotocardImages(group.name, member, imageCount, r) : [];
      const images = realPhotocardImages.length > 0
        ? realPhotocardImages
        : Array.from({ length: imageCount }, (_, k) =>
            makeImage('products', `seed-${seller}-${i}-${k}.png`, [group.name, member, type], 320, 440)
          );

      const sold = r() < 0.2;
      const reserved = !sold && r() < 0.12;
      const createdAt = daysAgo(Math.floor(r() * 90));

      products.push({
        seller: sellerDoc._id,
        title: title.slice(0, 100),
        description: [
          `${type === 'photocard' ? 'Photocard officielle' : type === 'album' ? 'Album officiel scellé' : 'Article officiel'} ${member ? member + ' — ' : ''}${group.name}.`,
          `État : ${pick([...CONDITIONS], r)}. Stockée à l'abri de la lumière, jamais pliée.`,
          'Envoi soigné avec protection rigide. Photos réelles sur demande.',
          sold ? 'VENDU — annonce conservée pour l\'historique.' : 'Prix ferme sauf mention contraire.'
        ].join(' '),
        price: basePrice,
        currency: 'EUR',
        condition: pick([...CONDITIONS], r),
        category: type === 'photocard' ? 'Photocards' : type === 'album' ? 'Albums' : 'Merchandising',
        type,
        kpopGroup: group.name,
        kpopMember: type === 'merch' ? undefined : member,
        albumName: type === 'merch' ? undefined : album,
        images,
        isAvailable: !sold && !reserved,
        isReserved: reserved,
        reservedFor: reserved ? pick(buyers, r)._id : undefined,
        isSold: sold,
        soldAt: sold ? new Date(createdAt.getTime() + 5 * 24 * 3600 * 1000) : undefined,
        soldTo: sold ? pick(buyers, r)._id : undefined,
        shippingOptions: {
          worldwide: r() < 0.5,
          nationalOnly: r() < 0.5,
          localPickup: r() < 0.3,
          nationalCost: 2 + Math.floor(r() * 4),
          worldwideCost: 6 + Math.floor(r() * 8)
        },
        allowOffers: r() < 0.4,
        minOfferPercentage: 70,
        isPayWhatYouWant: type === 'photocard' && r() < 0.08,
        views: Math.floor(r() * 400),
        favorites: Math.floor(r() * 30),
        createdAt,
        updatedAt: createdAt
      });
    }
  }

  const created = await Product.insertMany(products);
  console.log(`Annonces : ${created.length} créées.`);

  // Mise à jour des statistiques vendeurs.
  for (const { seller } of plan) {
    const sellerDoc = usersByName[seller];
    const own = created.filter((p: any) => p.seller.toString() === sellerDoc._id.toString());
    sellerDoc.statistics.totalListings = own.length;
    sellerDoc.statistics.totalSales = own.filter((p: any) => p.isSold).length;
    await sellerDoc.save();
  }

  return created;
}

async function seedPosts(users: any[]) {
  const authors = users.filter((u) => u.accountStatus === 'active');
  const roots: any[] = [];

  for (let i = 0; i < 15; i++) {
    const r = rng(`post-${i}`);
    const author = pick(authors, r);
    const withImage = r() < 0.35;
    const likers = authors.filter(() => r() < 0.4).map((u) => u._id);
    const createdAt = daysAgo(Math.floor(r() * 45));
    roots.push(
      await Post.create({
        author: author._id,
        content: POST_TEXTS[i % POST_TEXTS.length],
        images: withImage ? [makeImage('posts', `seed-post-${i}.png`, ['post', author.username], 800, 600)] : [],
        likes: likers,
        likesCount: likers.length,
        repliesCount: 0,
        isReply: false,
        createdAt,
        updatedAt: createdAt
      })
    );
  }

  let replyCount = 0;
  for (let i = 0; i < 6; i++) {
    const r = rng(`reply-${i}`);
    const parent = pick(roots, r);
    const author = pick(authors, r);
    const createdAt = new Date(parent.createdAt.getTime() + Math.floor(r() * 3 + 1) * 3600 * 1000);
    await Post.create({
      author: author._id,
      content: pick(
        ['Trop belle, félicitations !', 'Je suis preneuse si tu revends 👀', 'Même galère de mon côté...', 'Merci pour le tips !', 'Ça se négocie ?'],
        r
      ),
      likes: [],
      likesCount: 0,
      repliesCount: 0,
      parentPost: parent._id,
      isReply: true,
      createdAt,
      updatedAt: createdAt
    });
    parent.repliesCount += 1;
    await parent.save();
    replyCount++;
  }

  console.log(`Publications : ${roots.length} posts + ${replyCount} réponses.`);
}

async function seedUserFollows(usersByName: Record<string, any>) {
  const edges: [string, string][] = [
    ['clara_wty', 'mina_collects'],
    ['skz_archive', 'mina_collects'],
    ['kpop_leo', 'mina_collects'],
    ['sohee_x', 'mina_collects'],
    ['clara_wty', 'skz_archive'],
    ['skz_archive', 'kpop_leo'],
    ['mina_collects', 'skz_archive'],
    ['kpop_leo', 'clara_wty'],
    ['sohee_x', 'skz_archive'],
    ['mina_collects', 'kpop_leo'],
    ['clara_wty', 'kpop_leo'],
    ['skz_archive', 'clara_wty']
  ];
  await Follow.insertMany(
    edges.map(([f, t]) => ({ follower: usersByName[f]._id, following: usersByName[t]._id }))
  );
  console.log(`Abonnements entre membres : ${edges.length} créés.`);
}

/**
 * Ne renseigne que le côté utilisateur (`followedGroups`), qui pilote le feed
 * personnalisé du membre. Le côté groupe (`followers`) est laissé intact : les
 * groupes réels en base stockent ce champ dans un format hétérogène et ces
 * documents ne sont pas nettoyés par la purge.
 */
async function seedGroupFollows(users: any[], groups: any[]) {
  let links = 0;
  for (const user of users) {
    if (user.accountStatus !== 'active') continue;
    const r = rng(`groups-${user.username}`);
    const followed = groups.filter(() => r() < 0.5);
    if (followed.length === 0) followed.push(groups[0]);

    user.followedGroups = followed.map((g) => g._id);
    user.followedGroupsCount = followed.length;
    await user.save();
    links += followed.length;
  }
  console.log(`Suivis de groupes : ${links} liens créés (côté membre).`);
}

async function seedRatings(usersByName: Record<string, any>) {
  const targets = ['mina_collects', 'kpop_leo', 'skz_archive'];
  const reviewers = ['clara_wty', 'skz_archive', 'kpop_leo', 'seed_admin'];
  const reviews = [
    'Transaction parfaite, emballage au top et envoi ultra rapide. Je recommande !',
    'Photocard conforme à l\'annonce, vendeuse réactive. Merci !',
    'Tout s\'est bien passé, léger retard sur l\'envoi mais bonne communication.',
    'Article nickel, protection rigide, rien à redire.',
    'Bonne vendeuse, je rachèterai sans souci.'
  ];

  for (const target of targets) {
    const recipient = usersByName[target];
    const r = rng(`ratings-${target}`);
    const n = 3 + Math.floor(r() * 3);
    let sum = 0;

    for (let i = 0; i < n; i++) {
      const reviewerName = pick(reviewers.filter((x) => x !== target), r);
      const rating = 3 + Math.floor(r() * 3); // 3..5
      sum += rating;
      await Rating.create({
        reviewer: usersByName[reviewerName]._id,
        recipient: recipient._id,
        rating,
        review: reviews[i % reviews.length],
        type: 'seller',
        transaction: new mongoose.Types.ObjectId(),
        isVerifiedPurchase: r() < 0.7,
        createdAt: daysAgo(Math.floor(r() * 60))
      });
    }

    recipient.statistics.totalRatings = n;
    recipient.statistics.averageRating = Math.round((sum / n) * 10) / 10;
    recipient.sellerRating = recipient.statistics.averageRating;
    await recipient.save();
  }
  console.log('Avis vendeurs : créés et statistiques de profil recalculées.');
}

/** Un message à insérer dans un fil (texte simple ou message système d'offre). */
interface SeedMessage {
  from: 'mina' | 'other';
  text: string;
  contentType: 'text' | 'offer' | 'counter_offer' | 'system_notification';
  isSystem: boolean;
  /** `true` si Mina n'a pas encore lu ce message (badge non lu). */
  unreadByMina: boolean;
}

/** Étape d'une négociation : une offre acheteur ou une contre-offre vendeur. */
interface OfferStep {
  by: 'buyer' | 'seller';
  kind: 'initial' | 'counter';
  /** Fraction du prix affiché (0.7 = 70 %). */
  pct: number;
  status: 'pending' | 'rejected' | 'expired' | 'accepted';
  note?: string;
}

interface NegotiationSpec {
  buyer: string;
  productIndex: number;
  startDaysAgo: number;
  outcome: 'pending' | 'accepted' | 'rejected';
  favoritedByMina?: boolean;
  steps: OfferStep[];
}

/**
 * Construit un fil de négociation cohérent avec ce que l'app attend en lecture :
 * `Conversation.negotiation` + `Conversation.offerHistory` + `Product.negotiations`
 * + messages système d'offre / contre-offre (mêmes libellés que
 * conversationOfferService).
 */
async function buildNegotiationThread(
  spec: NegotiationSpec,
  mina: any,
  buyerDoc: any,
  product: any
): Promise<{ conversationId: any; messageCount: number }> {
  const cur = product.currency === 'EUR' ? '€' : product.currency;
  const amountOf = (pct: number) => Math.max(1, Math.round(product.price * pct));
  const start = daysAgo(spec.startDaysAgo);
  const at = (i: number) => new Date(start.getTime() + i * 4 * 3600 * 1000);

  // Le produit doit rester « offrable » pour que le vendeur puisse répondre depuis l'UI.
  product.allowOffers = true;
  product.minOfferPercentage = 50;
  product.isAvailable = spec.outcome !== 'accepted';
  product.isReserved = spec.outcome === 'accepted';
  if (spec.outcome === 'accepted') product.reservedFor = buyerDoc._id;

  const buyerSteps = spec.steps.filter((s) => s.by === 'buyer');
  const sellerCounters = spec.steps.filter((s) => s.by === 'seller');
  const firstBuyerAmt = amountOf(buyerSteps[0].pct);
  const lastBuyerAmt = amountOf(buyerSteps[buyerSteps.length - 1].pct);
  const lastCounterAmt = sellerCounters.length > 0
    ? amountOf(sellerCounters[sellerCounters.length - 1].pct)
    : undefined;

  const offerHistory = spec.steps.map((s, i) => ({
    offeredBy: (s.by === 'buyer' ? buyerDoc : mina)._id,
    amount: amountOf(s.pct),
    offerType: s.kind,
    status: s.status,
    message: s.note ?? '',
    createdAt: at(i),
    respondedAt: s.status === 'pending' ? undefined : at(i + 1)
  }));

  const conversation = await Conversation.create({
    participants: [mina._id, buyerDoc._id],
    productId: product._id,
    type: 'negotiation',
    title: `Négociation pour ${product.title}`,
    status: 'open',
    createdBy: buyerDoc._id,
    isActive: true,
    favoritedBy: spec.favoritedByMina ? [mina._id] : [],
    negotiation: {
      initialPrice: product.price,
      currentOffer: lastBuyerAmt,
      counterOffer: lastCounterAmt,
      status: spec.outcome
    },
    offerHistory,
    lastMessageAt: start
  });

  product.negotiations = product.negotiations ?? [];
  product.negotiations.push({
    buyer: buyerDoc._id,
    initialOffer: firstBuyerAmt,
    currentOffer: lastBuyerAmt,
    counterOffer: lastCounterAmt,
    status: spec.outcome,
    conversationId: conversation._id,
    createdAt: start,
    updatedAt: at(spec.steps.length)
  });
  await product.save();

  // Messages système : une ligne par offre / contre-offre, puis la résolution.
  const messages: SeedMessage[] = [];
  let prevBuyerAmt: number | null = null;
  spec.steps.forEach((s) => {
    const amt = amountOf(s.pct);
    if (s.by === 'buyer') {
      const text = prevBuyerAmt === null
        ? `Offre initiale de ${amt} ${cur}`
        : `Offre mise à jour de ${prevBuyerAmt} ${cur} à ${amt} ${cur}`;
      prevBuyerAmt = amt;
      messages.push({ from: 'other', text, contentType: 'offer', isSystem: true, unreadByMina: false });
      if (s.note) messages.push({ from: 'other', text: s.note, contentType: 'text', isSystem: false, unreadByMina: false });
    } else {
      messages.push({ from: 'mina', text: `🔄 Contre-offre de ${amt} ${cur}`, contentType: 'counter_offer', isSystem: true, unreadByMina: false });
      if (s.note) messages.push({ from: 'mina', text: s.note, contentType: 'text', isSystem: false, unreadByMina: false });
    }
  });

  if (spec.outcome === 'accepted') {
    messages.push({ from: 'mina', text: `Offre de ${lastBuyerAmt} ${cur} acceptée`, contentType: 'system_notification', isSystem: true, unreadByMina: false });
  } else if (spec.outcome === 'rejected') {
    const reason = spec.steps[spec.steps.length - 1].note;
    messages.push({
      from: 'mina',
      text: `Offre de ${lastBuyerAmt} ${cur} refusée${reason ? `\nRaison : ${reason}` : ''}`,
      contentType: 'system_notification', isSystem: true, unreadByMina: false
    });
  } else {
    // Négociation en cours : la dernière offre de l'acheteur n'est pas lue par Mina.
    for (let i = messages.length - 1; i >= 0 && messages[i].from === 'other'; i--) {
      messages[i].unreadByMina = true;
    }
  }

  const inserted = await insertThreadMessages(conversation, mina, buyerDoc, messages, start);
  return { conversationId: conversation._id, messageCount: inserted };
}

/** Insère les messages d'un fil, met à jour lastMessage / lastMessageAt. */
async function insertThreadMessages(
  conversation: any,
  mina: any,
  other: any,
  messages: SeedMessage[],
  start: Date
): Promise<number> {
  let lastMsg: any = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const sender = m.from === 'mina' ? mina : other;
    const createdAt = new Date(start.getTime() + (i + 1) * 90 * 60 * 1000);
    const readBy = m.unreadByMina ? [other._id] : [mina._id, other._id];
    lastMsg = await Message.create({
      conversation: conversation._id,
      sender: sender._id,
      content: m.text,
      contentType: m.contentType,
      readBy,
      isSystemMessage: m.isSystem,
      isDeleted: false,
      isActive: true,
      createdAt,
      updatedAt: createdAt
    });
  }
  conversation.lastMessage = lastMsg._id;
  conversation.lastMessageAt = lastMsg.createdAt;
  await conversation.save();
  return messages.length;
}

/**
 * Boîte de réception de `mina_collects` : fils de discussion crédibles — questions
 * sur une annonce, message support, vente clôturée — et plusieurs négociations
 * avec offres et contre-offres (en cours, acceptée, refusée). Certains fils
 * restent non lus côté Mina pour afficher un badge. Messages stockés en clair
 * (isEncrypted absent) : la couche de lecture ne déchiffre que si le message
 * est marqué chiffré.
 */
async function seedConversations(usersByName: Record<string, any>, products: any[]) {
  const mina = usersByName['mina_collects'];
  const minaProducts = products.filter((p) => p.seller.toString() === mina._id.toString());
  const productFor = (i: number) => minaProducts[i % minaProducts.length];

  interface SimpleThread {
    other: string;
    type: 'general' | 'product_inquiry';
    title?: string;
    productIndex?: number;
    status: 'open' | 'closed';
    archivedByMina?: boolean;
    favoritedByMina?: boolean;
    startDaysAgo: number;
    minaReadAll: boolean;
    lines: { from: 'mina' | 'other'; text: string }[];
  }

  const simpleThreads: SimpleThread[] = [
    {
      other: 'clara_wty', type: 'product_inquiry', productIndex: 0,
      status: 'open', favoritedByMina: true, startDaysAgo: 12, minaReadAll: true,
      lines: [
        { from: 'other', text: 'Bonjour ! La photocard est toujours disponible ?' },
        { from: 'mina', text: 'Oui, elle est en parfait état, jamais pliée 😊' },
        { from: 'other', text: 'Super. Tu envoies en suivi ?' },
        { from: 'mina', text: 'Oui, +2€ pour le suivi. Je te fais le récap et un PayPal G&S.' },
        { from: 'other', text: 'Parfait, merci beaucoup !' }
      ]
    },
    {
      other: 'skz_archive', type: 'product_inquiry', productIndex: 1,
      status: 'open', startDaysAgo: 5, minaReadAll: false,
      lines: [
        { from: 'other', text: 'Hello, tu aurais des photos réelles recto/verso ?' },
        { from: 'mina', text: 'Je t\'envoie ça ce soir en rentrant !' },
        { from: 'other', text: 'Nickel, merci.' },
        { from: 'other', text: 'Au fait, tu fais un prix si je prends plusieurs cartes ?' }
      ]
    },
    {
      other: 'seed_admin', type: 'general', title: 'Bienvenue sur MyKpopTrade',
      status: 'open', startDaysAgo: 25, minaReadAll: true,
      lines: [
        { from: 'other', text: 'Bonjour Mina, bienvenue ! N\'hésite pas si tu as des questions sur la vente ou la vérification vendeur.' },
        { from: 'mina', text: 'Merci beaucoup, tout est clair pour le moment !' }
      ]
    },
    {
      other: 'clara_wty', type: 'product_inquiry', productIndex: 4,
      status: 'closed', archivedByMina: true, startDaysAgo: 40, minaReadAll: true,
      lines: [
        { from: 'other', text: 'Bien reçu la carte aujourd\'hui, emballage nickel, merci ! 💜' },
        { from: 'mina', text: 'Super contente que ça te plaise, à bientôt !' }
      ]
    }
  ];

  let threadCount = 0;
  let messageCount = 0;

  for (const t of simpleThreads) {
    const other = usersByName[t.other];
    const start = daysAgo(t.startDaysAgo);
    const conversation = await Conversation.create({
      participants: [mina._id, other._id],
      productId: t.productIndex !== undefined ? productFor(t.productIndex)._id : undefined,
      type: t.type,
      title: t.title,
      status: t.status,
      createdBy: other._id,
      isActive: true,
      archivedBy: t.archivedByMina ? [mina._id] : [],
      favoritedBy: t.favoritedByMina ? [mina._id] : [],
      offerHistory: [],
      lastMessageAt: start
    });
    const messages: SeedMessage[] = t.lines.map((l) => ({
      from: l.from,
      text: l.text,
      contentType: 'text' as const,
      isSystem: false,
      unreadByMina: !t.minaReadAll && l.from === 'other'
    }));
    messageCount += await insertThreadMessages(conversation, mina, other, messages, start);
    threadCount++;
  }

  const negotiations: NegotiationSpec[] = [
    {
      // En cours : l'acheteur vient de re-proposer après une contre-offre → non lu.
      buyer: 'kpop_leo', productIndex: 3, startDaysAgo: 2, outcome: 'pending', favoritedByMina: true,
      steps: [
        { by: 'buyer', kind: 'initial', pct: 0.70, status: 'expired' },
        { by: 'seller', kind: 'counter', pct: 0.88, status: 'rejected', note: 'Je peux faire un petit geste mais pas à 70 %.' },
        { by: 'buyer', kind: 'initial', pct: 0.80, status: 'pending', note: 'On coupe la poire en deux à 80 % ?' }
      ]
    },
    {
      // Acceptée directement.
      buyer: 'skz_archive', productIndex: 6, startDaysAgo: 9, outcome: 'accepted',
      steps: [
        { by: 'buyer', kind: 'initial', pct: 0.90, status: 'accepted', note: 'Je te propose 90 %, paiement tout de suite.' }
      ]
    },
    {
      // Longue négo, plusieurs contre-offres, finit acceptée.
      buyer: 'clara_wty', productIndex: 8, startDaysAgo: 18, outcome: 'accepted',
      steps: [
        { by: 'buyer', kind: 'initial', pct: 0.60, status: 'expired' },
        { by: 'seller', kind: 'counter', pct: 0.92, status: 'rejected' },
        { by: 'buyer', kind: 'initial', pct: 0.78, status: 'rejected' },
        { by: 'seller', kind: 'counter', pct: 0.86, status: 'rejected' },
        { by: 'buyer', kind: 'initial', pct: 0.86, status: 'accepted', note: 'Ok pour 86 %, deal !' }
      ]
    },
    {
      // Refusée : prix ferme.
      buyer: 'kpop_leo', productIndex: 10, startDaysAgo: 30, outcome: 'rejected',
      steps: [
        { by: 'buyer', kind: 'initial', pct: 0.65, status: 'rejected', note: 'Désolée, prix ferme sur cette carte, elle part vite 🙏' }
      ]
    }
  ];

  for (const spec of negotiations) {
    const buyerDoc = usersByName[spec.buyer];
    const product = productFor(spec.productIndex);
    const { messageCount: mc } = await buildNegotiationThread(spec, mina, buyerDoc, product);
    messageCount += mc;
    threadCount++;
  }

  console.log(`Conversations (mina_collects) : ${threadCount} fils, ${messageCount} messages.`);
}

async function main() {
  if (!process.argv.includes('--yes')) {
    console.error('Ajoutez --yes pour confirmer l\'insertion des données de test.');
    console.error('Usage : npx ts-node src/scripts/seedTestData.ts --yes');
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production') {
    console.error('Refus : ce script ne doit pas tourner en production.');
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mykpoptrade';
  await mongoose.connect(uri);
  console.log(`Connecté à MongoDB : ${uri}`);

  try {
    await purgePreviousSeed();

    const groups = await resolveGroups();
    const users = await seedUsers();
    const usersByName: Record<string, any> = Object.fromEntries(users.map((u) => [u.username, u]));

    const products = await seedProducts(usersByName);
    await seedPosts(users);
    await seedUserFollows(usersByName);
    await seedGroupFollows(users, groups);
    await seedRatings(usersByName);
    await seedConversations(usersByName, products);

    console.log('\n✅ Seed terminé.');
    console.log(`   Connexion : <username>@${SEED_EMAIL_DOMAIN} / ${SEED_PASSWORD}`);
    console.log('   Admin     : seed_admin@' + SEED_EMAIL_DOMAIN);
  } catch (error) {
    console.error('Échec du seed :', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('Déconnecté de MongoDB.');
  }
}

main();
