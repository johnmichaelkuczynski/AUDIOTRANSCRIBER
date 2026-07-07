import { Router, type IRouter } from "express";
import { sql, count } from "drizzle-orm";
import { db, loginEventsTable } from "@workspace/db";
import { requireAuth } from "../../middlewares/requireAuth";
import { logger } from "../../lib/logger";

const router: IRouter = Router();

interface SeriesRow {
  label: string;
  count: string | number;
}

function toPoints(rows: SeriesRow[]): { label: string; count: number }[] {
  return rows.map((r) => ({ label: r.label, count: Number(r.count) }));
}

async function series(query: ReturnType<typeof sql>): Promise<{ label: string; count: number }[]> {
  const result = await db.execute(query);
  return toPoints(result.rows as unknown as SeriesRow[]);
}

router.get("/analytics/logins", requireAuth, async (_req, res): Promise<void> => {
  try {
    const [totals] = await db
      .select({
        day: sql<number>`count(*) filter (where ${loginEventsTable.createdAt} >= now() - interval '1 day')`,
        week: sql<number>`count(*) filter (where ${loginEventsTable.createdAt} >= now() - interval '7 days')`,
        month: sql<number>`count(*) filter (where ${loginEventsTable.createdAt} >= now() - interval '30 days')`,
        year: sql<number>`count(*) filter (where ${loginEventsTable.createdAt} >= now() - interval '365 days')`,
        allTime: count(),
      })
      .from(loginEventsTable);

    const [day, week, month, year, allTime] = await Promise.all([
      series(sql`
        select to_char(h, 'HH24:00') as label, coalesce(c.cnt, 0) as count
        from generate_series(
          date_trunc('hour', now()) - interval '23 hours',
          date_trunc('hour', now()),
          interval '1 hour'
        ) as h
        left join (
          select date_trunc('hour', created_at) as bucket, count(*) as cnt
          from login_events
          where created_at >= now() - interval '24 hours'
          group by 1
        ) c on c.bucket = h
        order by h
      `),
      series(sql`
        select to_char(d, 'Dy DD') as label, coalesce(c.cnt, 0) as count
        from generate_series(
          date_trunc('day', now()) - interval '6 days',
          date_trunc('day', now()),
          interval '1 day'
        ) as d
        left join (
          select date_trunc('day', created_at) as bucket, count(*) as cnt
          from login_events
          where created_at >= now() - interval '7 days'
          group by 1
        ) c on c.bucket = d
        order by d
      `),
      series(sql`
        select to_char(d, 'Mon DD') as label, coalesce(c.cnt, 0) as count
        from generate_series(
          date_trunc('day', now()) - interval '29 days',
          date_trunc('day', now()),
          interval '1 day'
        ) as d
        left join (
          select date_trunc('day', created_at) as bucket, count(*) as cnt
          from login_events
          where created_at >= now() - interval '30 days'
          group by 1
        ) c on c.bucket = d
        order by d
      `),
      series(sql`
        select to_char(m, 'Mon YY') as label, coalesce(c.cnt, 0) as count
        from generate_series(
          date_trunc('month', now()) - interval '11 months',
          date_trunc('month', now()),
          interval '1 month'
        ) as m
        left join (
          select date_trunc('month', created_at) as bucket, count(*) as cnt
          from login_events
          where created_at >= now() - interval '365 days'
          group by 1
        ) c on c.bucket = m
        order by m
      `),
      series(sql`
        select to_char(m, 'Mon YY') as label, coalesce(c.cnt, 0) as count
        from generate_series(
          date_trunc('month', coalesce((select min(created_at) from login_events), now())),
          date_trunc('month', now()),
          interval '1 month'
        ) as m
        left join (
          select date_trunc('month', created_at) as bucket, count(*) as cnt
          from login_events
          group by 1
        ) c on c.bucket = m
        order by m
      `),
    ]);

    res.json({
      totals: {
        day: Number(totals.day),
        week: Number(totals.week),
        month: Number(totals.month),
        year: Number(totals.year),
        allTime: Number(totals.allTime),
      },
      series: { day, week, month, year, allTime },
    });
  } catch (err) {
    logger.error({ err }, "Failed to compute login analytics");
    res.status(500).json({ error: "Failed to compute login analytics" });
  }
});

export default router;
