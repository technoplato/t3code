import {
  type CollisionDetection,
  closestCenter,
  DndContext,
  type DragEndEvent,
  type Modifier,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  restrictToHorizontalAxis,
  restrictToParentElement,
  restrictToVerticalAxis,
} from "@dnd-kit/modifiers";
import { rectSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  type ArrangedLimitPool,
  arrangeLimitPools,
  DEFAULT_LIMIT_ACCOUNTS_VIEW,
  type LimitAccountsView,
  moveLimitAccount,
} from "@t3tools/client-runtime/state/usage-limit-accounts";
import {
  CHATGPT_USAGE_URL,
  collectLimitAccounts,
  collectLimitPools,
  displayLimitWindows,
  type LimitAccount,
  type LimitPoolMember,
  type LimitPoolWindow,
  paceRemainingPercent,
  remainingPercent,
  type ResetCreditChoice,
} from "@t3tools/shared/usageLimits";
import { T, useGT, useMessages } from "gt-react";
import type { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  TicketIcon,
} from "lucide-react";
import {
  createContext,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  use,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { ensureLocalApi } from "../../localApi";
import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "../settings/providerDriverMeta";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { Button } from "../ui/button";
import { OpenAI } from "../Icons";
import { Alert, AlertTitle } from "../ui/alert";
import { Popover, PopoverCreateHandle, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { PaceIcon, ResetCreditDialog, barColor, usePaceMark, useResetCredit } from "./UsageLimits";
import {
  collectExternalUsageLinks,
  collectLimitNotices,
  cursorUsageWindowDetails,
  formatResetsIn,
  resetCreditChoices,
} from "@t3tools/shared/usageLimitsCopy";

// A segment and its legend row are separate drag targets for one account, each sorting on its own axis.
const segmentId = (accountKey: string) => `segment:${accountKey}`;
const legendId = (accountKey: string) => `legend:${accountKey}`;
const isSegmentId = (id: unknown) => String(id).startsWith("segment:");
const accountKeyOf = (id: unknown) => String(id).slice(String(id).indexOf(":") + 1);

const collideWithinGroup: CollisionDetection = (args) =>
  closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter(
      (container) => isSegmentId(container.id) === isSegmentId(args.active.id),
    ),
  });
const restrictToGroupAxis: Modifier = (args) =>
  isSegmentId(args.active?.id) ? restrictToHorizontalAxis(args) : restrictToVerticalAxis(args);
const ACCOUNT_DRAG_MODIFIERS = [restrictToGroupAxis, restrictToParentElement];
// useSensor memoizes on options identity; fresh options rebuild the DndContext and every segment.
const MOUSE_DRAG = { activationConstraint: { distance: 6 } };
const TOUCH_DRAG = { activationConstraint: { delay: 250, tolerance: 5 } };

/** Moves one account to another's place, or null where the order cannot be changed. */
const AccountMoveContext = createContext<((activeKey: string, overKey: string) => void) | null>(
  null,
);

function stepOnAltArrow(
  event: KeyboardEvent,
  [back, forward]: readonly [string, string],
  onStep: (delta: -1 | 1) => void,
) {
  if (!event.altKey || (event.key !== back && event.key !== forward)) return;
  event.preventDefault();
  onStep(event.key === back ? -1 : 1);
}

function accountInitials(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase() || "?";
}

function accountHue(email: string): number {
  let hash = 0;
  for (let index = 0; index < email.length; index += 1) {
    hash = (hash * 31 + email.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

function AccountChip({ email }: { readonly email: string }) {
  const hue = accountHue(email);
  const gt = useGT();
  return (
    <span
      role="img"
      aria-label={gt("Account {initials}", { initials: accountInitials(email) })}
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-3xs leading-none font-semibold"
      style={{ backgroundColor: `oklch(0.85 0.08 ${hue})`, color: `oklch(0.35 0.1 ${hue})` }}
    >
      {accountInitials(email)}
    </span>
  );
}

function AccountAvatar({
  account,
  className,
}: {
  readonly account: LimitAccount;
  readonly className?: string;
}) {
  if (account.redeem) {
    return (
      <ProviderInstanceIcon
        driverKind={account.driver}
        displayName={
          account.displayName ??
          providerClients.get(account.driver)?.label ??
          String(account.driver)
        }
        accentColor={account.accentColor}
        showBadge={Boolean(account.displayName)}
        indicatorBackground="var(--popover)"
        className={cn("size-5", className)}
        iconClassName="size-4 text-foreground/80"
      />
    );
  }
  return account.email ? <AccountChip email={account.email} /> : null;
}

function AccountName({
  account,
  className,
}: {
  readonly account: LimitAccount;
  readonly className?: string;
}) {
  if (account.displayName) return <span className={className}>{account.displayName}</span>;
  if (account.email) {
    return (
      <span className={cn("inline-flex min-w-0 items-center", className)}>
        <AccountChip email={account.email} />
      </span>
    );
  }
  return (
    <span className={className}>
      {providerClients.get(account.driver)?.label ?? String(account.driver)}
    </span>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-foreground tabular-nums">{children}</span>
    </div>
  );
}

function SegmentPopover({
  account,
  window,
  reset,
  now,
  redeem,
  onRedeem,
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly now: number;
  readonly redeem: ReturnType<typeof useResetCredit> | null;
  readonly onRedeem: (choice: ResetCreditChoice) => void;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const gt = useGT();
  const m = useMessages();
  const remaining = remainingPercent(window);
  const timeLeft = paceRemainingPercent(window, now);
  const resetsIn = formatResetsIn(window, now, m, "in");
  const where =
    account.environments.length > 0
      ? account.environments.map((environment) => environment.label).join(", ")
      : account.sourceLabel;
  const choices =
    redeem && account.redeem && account.limits.resetCredits?.availableCount
      ? resetCreditChoices(account.limits.resetCredits, account.redeem.input, now, true, m)
      : [];
  return (
    <div className="flex w-72 max-w-[calc(100vw-3rem)] flex-col gap-2.5 text-xs">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <AccountAvatar account={account} />
          <span className="truncate">
            {account.displayName ?? providerClients.get(account.driver)?.label ?? account.driver}
          </span>
        </span>
        {account.email ? (
          <RedactedSensitiveText
            value={account.email}
            ariaLabel={gt("Toggle account email visibility")}
            revealTooltip={gt("Click to reveal email")}
            hideTooltip={gt("Click to hide email")}
            className="w-fit"
          />
        ) : null}
      </div>
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
        {account.plan ? (
          <Row label={gt("Plan", { $context: "subscription plan" })}>{account.plan}</Row>
        ) : null}
        {where ? (
          <Row
            label={
              account.environments.length > 0
                ? gt("Signed in")
                : gt("Via", { $context: "signed in through a source" })
            }
          >
            {where}
          </Row>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
        <Row label={gt("Left", { $context: "remaining usage" })}>{remaining}%</Row>
        {window.resetsAt ? (
          <Row label={gt("Resets", { $context: "when the usage window resets" })}>
            {formatUpcomingTimestamp(window.resetsAt, timestampFormat, now, undefined, m)}
            {resetsIn ? ` · ${resetsIn}` : ""}
          </Row>
        ) : null}
        {timeLeft !== null ? (
          <Row label={gt("Even pace")}>{gt("{timeLeft}% left by now", { timeLeft })}</Row>
        ) : null}
        {reset && reset.restoresPercent > 0 ? (
          <Row label={gt("Restores", { $context: "a reset credit restores part of the pool" })}>
            {gt("+{percent}% of pool", { percent: reset.restoresPercent })}
          </Row>
        ) : null}
      </div>
      {choices.length > 0 && redeem ? (
        <div className="flex flex-col gap-1.5 border-t border-border/60 pt-2.5 text-muted-foreground">
          {choices.map((choice) => (
            <span key={choice.key} className="flex items-center gap-3">
              <span className="tabular-nums">{choice.summary}</span>
              {choice.availableCount > 0 ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={redeem.busy || !redeem.canManageProviders}
                  className="ms-auto"
                  onClick={() => onRedeem(choice)}
                >
                  {redeem.busy ? gt("Using…") : choice.actionLabel}
                </Button>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Every segment on the page shares one popover, so hovering or clicking another
 * segment moves it instead of opening a second one. The payload is the segment
 * it currently describes.
 */
type SegmentPayload = Omit<Parameters<typeof SegmentPopover>[0], "now" | "onRedeem">;
const SegmentPopoverContext = createContext<ReturnType<
  typeof PopoverCreateHandle<SegmentPayload>
> | null>(null);

function ActiveSegmentPopover({
  handle,
  actions,
  payload,
  pools,
  now,
}: {
  readonly handle: ReturnType<typeof PopoverCreateHandle<SegmentPayload>>;
  readonly actions: RefObject<PopoverPrimitive.Root.Actions | null>;
  readonly payload: SegmentPayload;
  readonly pools: readonly ArrangedLimitPool[];
  readonly now: number;
}) {
  const available = pools.some((pool) =>
    displayLimitWindows(pool).some((window) =>
      window.columns.some(
        (member) =>
          member.account.key === payload.account.key &&
          member.window?.id === payload.window.id &&
          member.window.kind === payload.window.kind &&
          Boolean(member.account.redeem) === Boolean(payload.redeem),
      ),
    ),
  );
  // The trigger is gone, so the popup has nothing to anchor to: an exit transition would
  // slide it to the viewport origin. Unmount it outright, which also clears Base UI's
  // active-trigger bookkeeping so the segment can open again when it comes back.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the popover handle and unmounts the Base UI popup before paint when its trigger is gone
  useLayoutEffect(() => {
    if (available) return;
    handle.close();
    actions.current?.unmount();
  }, [available, handle, actions]);
  return (
    <PopoverPopup side="top" sideOffset={6}>
      <SegmentPopover
        {...payload}
        now={now}
        onRedeem={(choice) => {
          handle.close();
          payload.redeem?.confirm(choice);
        }}
      />
    </PopoverPopup>
  );
}

/**
 * The confirm is a sibling of the popover, not a child: dialogs stack under
 * popovers, and the popover closes as the confirm opens.
 */
function PoolSegment({
  account,
  ...props
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly refillPercent: number;
  readonly color: string;
  readonly now: number;
  readonly index: number;
  readonly showAccountName: boolean;
  readonly hoverable: boolean;
  readonly onStep: (delta: -1 | 1) => void;
}) {
  return account.redeem ? (
    <RedeemableSegment account={account} redeemAt={account.redeem} {...props} />
  ) : (
    <SegmentTriggers account={account} redeem={null} {...props} />
  );
}

function RedeemableSegment({
  redeemAt,
  ...props
}: Omit<Parameters<typeof SegmentTriggers>[0], "redeem"> & {
  readonly redeemAt: NonNullable<LimitAccount["redeem"]>;
}) {
  const redeem = useResetCredit(redeemAt.environmentId);
  const gt = useGT();
  return (
    <>
      <SegmentTriggers redeem={redeem} {...props} />
      <ResetCreditDialog
        open={redeem.confirming}
        onOpenChange={redeem.setConfirming}
        choice={redeem.choice}
        onConfirm={() => void redeem.redeem()}
        disabled={!redeem.canManageProviders}
      />
      {/* The popover closed before the confirm, so progress and the outcome need a home outside it. */}
      {redeem.busy || redeem.status ? (
        <span role="status" className="col-span-full text-xs text-muted-foreground">
          <AccountName account={props.account} className="font-medium text-foreground" />{" "}
          {redeem.busy ? gt("Using reset credit…") : redeem.status}
        </span>
      ) : null}
    </>
  );
}

function SegmentTriggers({
  account,
  window,
  reset,
  redeem,
  refillPercent,
  color,
  now,
  index,
  showAccountName,
  hoverable,
  onStep,
}: SegmentPayload & {
  readonly refillPercent: number;
  readonly color: string;
  readonly now: number;
  readonly index: number;
  readonly showAccountName: boolean;
  readonly hoverable: boolean;
  readonly onStep: (delta: -1 | 1) => void;
}) {
  const popover = use(SegmentPopoverContext) ?? undefined;
  const movable = use(AccountMoveContext) !== null;
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: segmentId(account.key),
    disabled: !movable,
  });
  const payload: SegmentPayload = { account, window, reset, redeem };
  const remaining = remainingPercent(window);
  const timeLeft = paceRemainingPercent(window, now);
  const [segmentRef, paceMark] = usePaceMark(timeLeft);
  const m = useMessages();
  const resetsIn = formatResetsIn(window, now, m);
  const refillIn = formatResetsIn(window, now, m, "refill");
  const credits = account.limits.resetCredits?.availableCount ?? 0;
  const gt = useGT();
  const segmentLabel = [
    gt("{name}: {remaining}% left", {
      name:
        account.displayName ?? (account.email ? accountInitials(account.email) : account.driver),
      remaining,
    }),
    resetsIn,
    timeLeft === null ? null : gt("{timeLeft}% of the window left", { timeLeft }),
    credits
      ? gt(
          "{count, plural, one {{count} reset credit banked} other {{count} reset credits banked}}",
          { count: credits },
        )
      : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <>
      <PopoverTrigger
        handle={popover}
        payload={payload}
        openOnHover={hoverable}
        render={
          <button
            ref={setNodeRef}
            type="button"
            style={{
              gridColumn: index,
              gridRow: 1,
              ...paceMark?.gappedTrack,
              transform: CSS.Translate.toString(transform),
              transition,
            }}
            aria-label={segmentLabel}
            aria-keyshortcuts={movable ? "Alt+ArrowLeft Alt+ArrowRight" : undefined}
            className={cn(
              "relative h-5 min-w-0 cursor-pointer touch-manipulation rounded-md bg-muted text-start outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background data-[popup-open]:ring-1 data-[popup-open]:ring-inset data-[popup-open]:ring-border @2xl/pool:h-8",
              isDragging && "z-10 shadow-md",
            )}
            {...listeners}
            onKeyDown={
              movable
                ? (event) => stepOnAltArrow(event, ["ArrowLeft", "ArrowRight"], onStep)
                : undefined
            }
          />
        }
      >
        {/* The pace mark measures this layer: it fills the segment, whose own ref the drag owns. */}
        <div ref={segmentRef} aria-hidden className="absolute inset-0 overflow-hidden rounded-md">
          {/* Clipped inside the rounded clip so the bar's own corners keep their antialiasing. */}
          <div className="absolute inset-0" style={paceMark?.gap}>
            <div
              aria-hidden
              className="absolute inset-y-0 left-0 rounded-md opacity-35"
              style={{ width: `${remaining}%`, backgroundColor: color }}
            />
            {remaining < 100 && reset && refillPercent > 0 ? (
              <div
                aria-hidden
                className="absolute inset-y-0 right-0 opacity-20"
                style={{
                  width: `${Math.min(100 - remaining, refillPercent)}%`,
                  // A bare 45° gradient repeats every 5√2px, so some stripes rasterize thinner; a whole-pixel tile doesn't.
                  backgroundImage: `repeating-linear-gradient(135deg, transparent 0 1px, ${color} 1px 2px, transparent 2px 50%)`,
                  backgroundSize: "7px 7px",
                }}
              />
            ) : null}
          </div>
        </div>
        {paceMark ? (
          <span
            aria-hidden
            className="absolute inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
            style={paceMark.tick}
          />
        ) : null}
        <span
          aria-hidden
          className="absolute inset-0 flex items-center justify-center overflow-hidden rounded-md text-3xs leading-none font-semibold text-foreground/80 tabular-nums @2xl/pool:hidden"
        >
          {index}
        </span>
        <div className="relative hidden h-full min-w-0 items-center gap-1.5 overflow-hidden rounded-md px-2 text-xs @2xl/pool:flex">
          {showAccountName ? (
            <AccountName
              account={account}
              className="min-w-0 truncate font-medium text-foreground"
            />
          ) : null}
          {/* A single-account bar repeats the headline percentage. */}
          {showAccountName ? (
            <span className="shrink-0 font-semibold text-foreground tabular-nums">
              {remaining}%
            </span>
          ) : null}
          {resetsIn || credits ? (
            <span className="ms-auto flex min-w-0 items-center gap-1.5 overflow-hidden rounded-sm bg-background/85 px-1.5 py-0.5 text-2xs whitespace-nowrap text-foreground tabular-nums">
              {refillIn ?? ""}
              {credits ? (
                <>
                  {resetsIn ? (
                    <span aria-hidden className="text-muted-foreground">
                      ·
                    </span>
                  ) : null}
                  <span aria-hidden className="inline-flex items-center gap-0.5 font-semibold">
                    <TicketIcon className="size-3" aria-hidden />
                    {credits}
                  </span>
                </>
              ) : null}
            </span>
          ) : null}
        </div>
      </PopoverTrigger>
      <LegendRow payload={payload} color={color} now={now} index={index} onStep={onStep} />
    </>
  );
}

function LegendRow({
  payload,
  color,
  now,
  index,
  onStep,
}: {
  readonly payload: SegmentPayload;
  readonly color: string;
  readonly now: number;
  readonly index: number;
  readonly onStep: (delta: -1 | 1) => void;
}) {
  const popover = use(SegmentPopoverContext) ?? undefined;
  const movable = use(AccountMoveContext) !== null;
  const { account, window } = payload;
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: legendId(account.key),
    disabled: !movable,
  });
  const remaining = remainingPercent(window);
  const m = useMessages();
  const resetsIn = formatResetsIn(window, now, m, "refill");
  const credits = account.limits.resetCredits?.availableCount ?? 0;
  const gt = useGT();
  return (
    <PopoverTrigger
      ref={setNodeRef}
      handle={popover}
      payload={payload}
      style={{
        gridColumn: "1 / -1",
        gridRow: index + 1,
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      render={<Button variant="ghost" size="compact" />}
      className={cn("min-w-0 @2xl/pool:hidden", isDragging && "relative z-10")}
      aria-keyshortcuts={movable ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
      {...listeners}
      onKeyDown={
        movable ? (event) => stepOnAltArrow(event, ["ArrowUp", "ArrowDown"], onStep) : undefined
      }
    >
      <span className="relative inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-3xs leading-none font-semibold text-foreground/80 tabular-nums">
        <span
          aria-hidden
          className="absolute inset-0 rounded-sm opacity-35"
          style={{ backgroundColor: color }}
        />
        <span className="sr-only">{`${gt("Segment")} `}</span>
        <span className="relative">{index}</span>
      </span>
      <AccountName account={account} className="min-w-0 truncate font-medium text-foreground" />
      <span className="shrink-0 font-semibold text-foreground tabular-nums">{remaining}%</span>
      <span className="ms-auto flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground tabular-nums">
        {resetsIn ?? ""}
        {credits ? (
          <>
            {resetsIn ? <span aria-hidden>·</span> : null}
            <span
              aria-hidden
              className="inline-flex items-center gap-0.5 font-semibold text-foreground"
            >
              <TicketIcon className="size-3" aria-hidden />
              {credits}
            </span>
            <span className="sr-only">
              {gt(
                "{count, plural, one {{count} reset credit banked} other {{count} reset credits banked}}",
                { count: credits },
              )}
            </span>
          </>
        ) : null}
      </span>
    </PopoverTrigger>
  );
}

function PoolBar({
  pool,
  color,
  now,
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
}) {
  const restores = new Map(pool.resets.map((reset) => [reset.member.account.key, reset]));
  const gt = useGT();
  const move = use(AccountMoveContext);
  const popover = use(SegmentPopoverContext);
  const [dragging, setDragging] = useState(false);
  const sensors = useSensors(
    useSensor(MouseSensor, MOUSE_DRAG),
    useSensor(TouchSensor, TOUCH_DRAG),
  );
  const keys = pool.columns.flatMap((member) => (member.window ? [member.account.key] : []));
  const step = (key: string, delta: -1 | 1) => {
    const over = keys[keys.indexOf(key) + delta];
    if (over !== undefined) move?.(key, over);
  };
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(false);
    if (over && active.id !== over.id) move?.(accountKeyOf(active.id), accountKeyOf(over.id));
  };
  return (
    <div className="@container/pool min-w-0">
      <DndContext
        sensors={sensors}
        collisionDetection={collideWithinGroup}
        modifiers={ACCOUNT_DRAG_MODIFIERS}
        onDragStart={() => {
          // A hover popover would otherwise ride along with the segment being dragged.
          setDragging(true);
          popover?.close();
        }}
        onDragCancel={() => setDragging(false)}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={[...keys.map(segmentId), ...keys.map(legendId)]}
          strategy={rectSortingStrategy}
        >
          <div
            className="grid gap-x-1 gap-y-1"
            style={{ gridTemplateColumns: `repeat(${pool.columns.length}, minmax(0, 1fr))` }}
          >
            {pool.columns.map((member, position) =>
              member.window ? (
                <PoolSegment
                  key={member.account.key}
                  account={member.account}
                  window={member.window}
                  reset={restores.get(member.account.key)}
                  refillPercent={member.refillPercent}
                  color={normalizeProviderAccentColor(member.account.accentColor) ?? color}
                  now={now}
                  index={position + 1}
                  showAccountName={pool.columns.length > 1}
                  hoverable={!dragging}
                  onStep={(delta) => step(member.account.key, delta)}
                />
              ) : pool.kind === "monthly" && member.account.limits.zeroSpendCap ? (
                <div
                  key={member.account.key}
                  style={{ gridColumn: position + 1, gridRow: 1 }}
                  className="flex h-5 min-w-0 items-center justify-center gap-1.5 overflow-hidden rounded-md border border-dashed border-border text-3xs whitespace-nowrap text-muted-foreground @2xl/pool:h-8 @2xl/pool:justify-start @2xl/pool:px-2 @2xl/pool:text-xs"
                >
                  <AccountName
                    account={member.account}
                    className="hidden min-w-0 truncate @2xl/pool:inline-flex"
                  />
                  {gt("$0 cap")}
                </div>
              ) : null,
            )}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function PoolWindowCard({
  pool,
  color,
  now,
  label,
  description,
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
  readonly label?: string | null | undefined;
  readonly description?: string | undefined;
}) {
  const nextRefill = pool.resets.find((reset) => reset.restoresPercent > 0);
  return (
    <div className="grid items-center gap-x-6 gap-y-3 rounded-lg border border-border/60 p-4 md:grid-cols-[11rem_minmax(0,1fr)]">
      <div className="flex flex-col gap-1">
        {label !== null ? (
          <span className="text-sm font-medium text-foreground">{label ?? pool.label}</span>
        ) : null}
        <span className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold text-foreground tabular-nums">
            {pool.remainingPercent}%
          </span>
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <span>
              <T context="remaining usage percentage">left</T>
            </span>
            {pool.pace ? <PaceIcon pace={pool.pace} /> : null}
          </span>
        </span>
        {nextRefill && pool.columns.length > 1 ? (
          <span className="text-xs font-medium text-foreground tabular-nums">
            ↻ +{nextRefill.restoresPercent}%
          </span>
        ) : null}
      </div>
      <PoolBar pool={pool} color={color} now={now} />
      {description ? (
        <p className="text-xs text-muted-foreground md:col-span-2">{description}</p>
      ) : null}
    </div>
  );
}

function HiddenAccountsRow({
  pool,
  revealed,
  onToggle,
}: {
  readonly pool: ArrangedLimitPool;
  readonly revealed: boolean;
  readonly onToggle: () => void;
}) {
  const gt = useGT();
  const { hiddenEmptySessions: sessions, hiddenEmptyWeeks: weeks } = pool;
  const label =
    sessions > 0 && weeks > 0
      ? gt("{count} hidden: empty sessions and empty weeks", { count: pool.hidden.length })
      : sessions > 0
        ? gt(
            "{count, plural, one {{count} empty session hidden} other {{count} empty sessions hidden}}",
            { count: sessions },
          )
        : gt(
            "{count, plural, one {{count} empty week hidden} other {{count} empty weeks hidden}}",
            {
              count: weeks,
            },
          );
  return (
    <div className="flex">
      <Button variant="ghost-muted" size="xs" aria-expanded={revealed} onClick={onToggle}>
        {label}
        {revealed ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
      </Button>
    </div>
  );
}

function PoolSection({
  pool,
  now,
  hiddenRevealed,
  onToggleHidden,
}: {
  readonly pool: ArrangedLimitPool;
  readonly now: number;
  readonly hiddenRevealed: boolean;
  readonly onToggleHidden: () => void;
}) {
  const color = barColor(pool.driver);
  const label = providerClients.get(pool.driver)?.label ?? String(pool.driver);
  const windows = displayLimitWindows(pool);
  const m = useMessages();
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
        <ProviderInstanceIcon
          driverKind={pool.driver}
          displayName={label}
          indicatorBackground="var(--background)"
          className="size-5"
          iconClassName="size-4 text-foreground/80"
        />
        {label}
      </h2>
      {windows.map((window) => {
        const details =
          pool.driver === "cursor" ? cursorUsageWindowDetails(window.id, pool, m) : undefined;
        return (
          <PoolWindowCard
            key={`${window.kind}:${window.id}`}
            pool={window}
            color={color}
            now={now}
            label={details?.label}
            description={details?.description}
          />
        );
      })}
      {pool.hidden.length > 0 ? (
        <HiddenAccountsRow pool={pool} revealed={hiddenRevealed} onToggle={onToggleHidden} />
      ) : null}
    </section>
  );
}

export function UsageLimitsPooled({
  presentations,
  now,
  accountsView = DEFAULT_LIMIT_ACCOUNTS_VIEW,
  onAccountsViewChange,
}: {
  readonly presentations: Parameters<typeof collectLimitAccounts>[0];
  readonly now: number;
  readonly accountsView?: LimitAccountsView;
  readonly onAccountsViewChange?: (view: LimitAccountsView) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const [segmentPopover] = useState(() => PopoverCreateHandle<SegmentPayload>());
  const segmentPopoverActions = useRef<PopoverPrimitive.Root.Actions | null>(null);
  const [hiddenRevealed, setHiddenRevealed] = useState(false);
  const everyPool = collectLimitPools(collectLimitAccounts(presentations), now);
  const pools = arrangeLimitPools(everyPool, accountsView, now, hiddenRevealed);
  const moveAccount = onAccountsViewChange
    ? (activeKey: string, overKey: string) =>
        onAccountsViewChange(moveLimitAccount(everyPool, accountsView, activeKey, overKey))
    : null;
  const notices = collectLimitNotices(presentations, m);
  const externalLinks = collectExternalUsageLinks(presentations, m);
  return (
    <div className="flex flex-col gap-8">
      {pools.length === 0 && notices.length === 0 && externalLinks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <T>No provider on the selected environments reports subscription limits.</T>
        </p>
      ) : null}
      <SegmentPopoverContext value={segmentPopover}>
        <AccountMoveContext value={moveAccount}>
          {pools.map((pool) => (
            <Fragment key={pool.driver}>
              <PoolSection
                pool={pool}
                now={now}
                hiddenRevealed={hiddenRevealed}
                onToggleHidden={() => setHiddenRevealed((revealed) => !revealed)}
              />
            </Fragment>
          ))}
        </AccountMoveContext>
      </SegmentPopoverContext>
      <Popover handle={segmentPopover} actionsRef={segmentPopoverActions}>
        {({ payload }) =>
          payload ? (
            <ActiveSegmentPopover
              handle={segmentPopover}
              actions={segmentPopoverActions}
              payload={payload}
              pools={pools}
              now={now}
            />
          ) : null
        }
      </Popover>
      {externalLinks.map((link) => (
        <section
          key={link.url}
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {link.url === CHATGPT_USAGE_URL ? (
              <OpenAI className="size-5 shrink-0" aria-hidden="true" />
            ) : null}
            <div className="min-w-0 space-y-1">
              <h2 className="text-sm font-medium">{link.label}</h2>
              <p className="text-xs break-words text-muted-foreground">
                {link.accounts.join(", ")}
              </p>
              {link.url === CHATGPT_USAGE_URL ? (
                <p className="text-xs text-muted-foreground">
                  <T>View usage in ChatGPT with your connected account.</T>
                </p>
              ) : link.message ? (
                <p className="max-w-xl text-xs text-muted-foreground">{link.message}</p>
              ) : null}
            </div>
          </div>
          <Button
            variant="ghost-muted"
            size="xs"
            onClick={() => void ensureLocalApi().shell.openExternal(link.url)}
          >
            {gt("Manage usage")}
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </section>
      ))}
      <LimitNotices notices={notices} />
    </div>
  );
}

function LimitNotices({ notices }: { readonly notices: readonly string[] }) {
  if (notices.length === 0) return null;
  return (
    <Alert variant="warning" controlAlignment="first-line">
      <AlertTriangleIcon />
      {notices.map((notice) => (
        <AlertTitle key={notice} className="break-words">
          {notice}
        </AlertTitle>
      ))}
    </Alert>
  );
}
