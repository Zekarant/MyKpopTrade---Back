import User from '../../../models/userModel';
import Product from '../../../models/productModel';
import Report from '../../../models/reportModel';
import Payment from '../../../models/paymentModel';
import { roundToCents } from '../../../commons/utils/moneyMath';

const NEW_USERS_WINDOW_DAYS = 30;
export const TIMESERIES_DAYS = 30;

/** Compteurs de membres du tableau de bord admin. */
export async function getUserCounts(now: Date = new Date()) {
  const newUsersSince = new Date(now);
  newUsersSince.setDate(newUsersSince.getDate() - NEW_USERS_WINDOW_DAYS);

  const [totalUsers, activeUsers, suspendedUsers, newUsers] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ accountStatus: 'active' }),
    User.countDocuments({ accountStatus: 'suspended' }),
    User.countDocuments({ createdAt: { $gte: newUsersSince } })
  ]);

  return { totalUsers, activeUsers, suspendedUsers, newUsers };
}

interface DailyBucket {
  _id: string;
  count: number;
  amount: number;
}

const toDayKey = (date: Date): string => date.toISOString().slice(0, 10);

const indexDailyBuckets = (buckets: DailyBucket[], field: 'count' | 'amount' = 'count'): Record<string, number> =>
  buckets.reduce((acc: Record<string, number>, bucket) => {
    acc[bucket._id] = bucket[field] ?? 0;
    return acc;
  }, {});

const dailyCountPipeline = (dateField: string, since: Date, match: Record<string, unknown> = {}) => [
  { $match: { ...match, [dateField]: { $gte: since } } },
  {
    $group: {
      _id: { $dateToString: { format: '%Y-%m-%d', date: `$${dateField}` } },
      count: { $sum: 1 },
      amount: { $sum: '$amount' }
    }
  }
];

/** Activité quotidienne (UTC) des `TIMESERIES_DAYS` derniers jours, jour courant inclus. */
export async function getDailyActivity(now: Date = new Date()) {
  const since = new Date(now);
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (TIMESERIES_DAYS - 1));

  const [signups, listings, sales, reports] = await Promise.all([
    User.aggregate<DailyBucket>(dailyCountPipeline('createdAt', since)),
    Product.aggregate<DailyBucket>(dailyCountPipeline('createdAt', since)),
    Payment.aggregate<DailyBucket>(dailyCountPipeline('completedAt', since, { status: 'completed' })),
    Report.aggregate<DailyBucket>(dailyCountPipeline('createdAt', since))
  ]);

  const signupsByDay = indexDailyBuckets(signups);
  const listingsByDay = indexDailyBuckets(listings);
  const salesByDay = indexDailyBuckets(sales);
  const revenueByDay = indexDailyBuckets(sales, 'amount');
  const reportsByDay = indexDailyBuckets(reports);

  return Array.from({ length: TIMESERIES_DAYS }, (_, offset) => {
    const day = new Date(since);
    day.setUTCDate(day.getUTCDate() + offset);
    const key = toDayKey(day);

    return {
      date: key,
      signups: signupsByDay[key] ?? 0,
      listings: listingsByDay[key] ?? 0,
      sales: salesByDay[key] ?? 0,
      revenue: roundToCents(revenueByDay[key] ?? 0),
      reports: reportsByDay[key] ?? 0
    };
  });
}
