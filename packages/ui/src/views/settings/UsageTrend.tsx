import type { UsageTrend as Trend } from "@trackwall/protocol";
import { tokenCount } from "@/lib/copilot-usage";
import { showsLabel, trendChart } from "@/lib/usage-trend";
import { cn } from "@/lib/utils";

/**
 * The usage trend (ADR-234) above the weekly report in Settings › Usage: the input tokens of every week the report
 * reaches, the tool definitions set apart, so a change meant to lower the use shows as a step down from its week.
 * Picking a bar opens that week's report below. Plain elements, no chart library; the colours are the `chart` tokens.
 */
export function UsageTrend({ trend, weeksAgo, onPick }: { trend: Trend; weeksAgo: number; onPick: (weeksAgo: number) => void }) {
  const { ticks, bars } = trendChart(trend.weeks);
  return (
    <figure className="m-0 flex flex-col gap-2" aria-label="Tokens in by week">
      <figcaption className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="hud-label">Tokens in by week</span>
        <Key className="bg-chart-1" label="Other tokens in" />
        <Key className="bg-chart-2" label="Tool definitions" />
      </figcaption>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
        <div className="relative h-36 w-9" aria-hidden>
          {ticks.map((tick) => (
            <span
              key={tick.value}
              className="text-muted-foreground absolute right-0 translate-y-1/2 font-mono text-2xs"
              style={{ bottom: `${tick.percent}%` }}
            >
              {tokenCount(tick.value)}
            </span>
          ))}
        </div>
        <div className="relative h-36">
          {ticks.map((tick) => (
            <span key={tick.value} aria-hidden className="absolute inset-x-0 border-t" style={{ bottom: `${tick.percent}%` }} />
          ))}
          <div className="relative flex h-full items-end gap-1">
            {bars.map((bar) => (
              <button
                key={bar.weeksAgo}
                type="button"
                title={bar.title}
                aria-label={bar.title}
                aria-pressed={bar.weeksAgo === weeksAgo}
                onClick={() => onPick(bar.weeksAgo)}
                className={cn(
                  "hover:bg-accent focus-visible:ring-ring flex h-full min-w-0 flex-1 flex-col justify-end rounded-sm outline-none focus-visible:ring-2",
                  bar.weeksAgo === weeksAgo && "bg-accent ring-primary ring-1",
                )}
              >
                <Segment className="bg-chart-1" percent={bar.restPercent} top />
                {/* Its top border is the gap between the two parts, inside its height, so the bar ends on its scale line. */}
                <Segment
                  className={cn(
                    "bg-chart-2 bg-clip-padding",
                    bar.restPercent > 0 && bar.definitionsPercent > 0 && "border-t-2 border-transparent",
                  )}
                  percent={bar.definitionsPercent}
                  top={bar.restPercent === 0}
                />
              </button>
            ))}
          </div>
        </div>
        <span />
        <div className="flex gap-1 pt-1" aria-hidden>
          {bars.map((bar) => (
            <span
              key={bar.weeksAgo}
              className={cn(
                "flex min-w-0 flex-1 justify-center font-mono text-2xs whitespace-nowrap",
                bar.weeksAgo === weeksAgo ? "text-foreground" : "text-muted-foreground",
                !showsLabel(bar.weeksAgo, weeksAgo) && "invisible",
              )}
            >
              {bar.label}
            </span>
          ))}
        </div>
      </div>
      {trend.unreadLogs > 0 && (
        <p className="text-muted-foreground text-xs">
          {trend.unreadLogs} {trend.unreadLogs === 1 ? "log" : "logs"} could not be read, so their use is missing from every week.
        </p>
      )}
    </figure>
  );
}

/** One part of a week's bar; the part on top has its corners rounded. */
function Segment({ className, percent, top }: { className: string; percent: number; top: boolean }) {
  return <span className={cn("mx-1", top && "rounded-t-sm", className)} style={{ height: `${percent}%` }} />;
}

function Key({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className={cn("size-2.5 rounded-xs", className)} />
      {label}
    </span>
  );
}
