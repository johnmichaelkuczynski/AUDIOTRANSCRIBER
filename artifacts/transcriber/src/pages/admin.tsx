import { useState } from "react";
import { useGetLoginAnalytics, getGetLoginAnalyticsQueryKey } from "@workspace/api-client-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { Users } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";

type RangeKey = "day" | "week" | "month" | "year" | "allTime";

const RANGES: { key: RangeKey; label: string; description: string }[] = [
  { key: "day", label: "Last day", description: "Hourly, past 24 hours" },
  { key: "week", label: "Last week", description: "Daily, past 7 days" },
  { key: "month", label: "Last month", description: "Daily, past 30 days" },
  { key: "year", label: "Last year", description: "Monthly, past 12 months" },
  { key: "allTime", label: "All time", description: "Monthly, since first login" },
];

function formatLoginDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function Admin() {
  const [range, setRange] = useState<RangeKey>("week");
  const { data, isLoading, isError } = useGetLoginAnalytics({
    query: { queryKey: getGetLoginAnalyticsQueryKey() },
  });

  const active = RANGES.find((r) => r.key === range)!;

  return (
    <div className="min-h-[100dvh] bg-background">
      <AppHeader />

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12 space-y-8">
        <div className="space-y-1">
          <h2 className="text-2xl font-bold tracking-tight text-foreground">Administrative</h2>
          <p className="text-muted-foreground">Google sign-in activity and analytics.</p>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-24">
            <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
          </div>
        )}

        {isError && (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-6 text-destructive">
            Failed to load data. Please try again.
          </div>
        )}

        {data && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {RANGES.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setRange(key)}
                  className={`rounded-2xl border p-4 text-left transition-colors ${
                    range === key
                      ? "border-primary bg-primary/5"
                      : "border-border bg-card hover:bg-secondary"
                  }`}
                >
                  <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    {label}
                  </div>
                  <div className="mt-1 text-2xl font-bold text-foreground">
                    {data.totals[key].toLocaleString()}
                  </div>
                  <div className="text-xs text-muted-foreground">logins</div>
                </button>
              ))}
            </div>

            <div className="rounded-2xl border border-border bg-card p-4 sm:p-6">
              <div className="mb-4">
                <h3 className="font-bold text-foreground">{active.label}</h3>
                <p className="text-sm text-muted-foreground">{active.description}</p>
              </div>
              <div className="h-72 sm:h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.series[range]} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(40 20% 88%)" vertical={false} />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 11, fill: "hsl(24 10% 40%)" }}
                      tickLine={false}
                      axisLine={{ stroke: "hsl(40 20% 88%)" }}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fontSize: 11, fill: "hsl(24 10% 40%)" }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      cursor={{ fill: "hsl(40 25% 95%)" }}
                      contentStyle={{
                        borderRadius: 12,
                        border: "1px solid hsl(40 20% 88%)",
                        fontSize: 13,
                      }}
                      formatter={(value: number) => [value, "Logins"]}
                    />
                    <Bar dataKey="count" fill="hsl(12 80% 50%)" radius={[6, 6, 0, 0]} maxBarSize={48} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-card">
              <div className="p-4 sm:p-6 border-b border-border flex items-center gap-2">
                <Users className="w-4 h-4 text-primary" />
                <h3 className="font-bold text-foreground">Login history</h3>
                <span className="ml-auto text-xs text-muted-foreground">
                  {data.recentLogins.length} most recent
                </span>
              </div>
              {data.recentLogins.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  No logins recorded yet.
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {data.recentLogins.map((login) => (
                    <li
                      key={login.id}
                      className="px-4 sm:px-6 py-3 flex items-center gap-3"
                    >
                      {login.picture ? (
                        <img
                          src={login.picture}
                          alt=""
                          referrerPolicy="no-referrer"
                          className="w-8 h-8 rounded-full border border-border shrink-0"
                        />
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center text-xs font-bold text-accent-foreground shrink-0">
                          {login.email.charAt(0).toUpperCase()}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-foreground truncate">
                          {login.name ?? login.email}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">{login.email}</div>
                      </div>
                      <div className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatLoginDate(login.createdAt)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
