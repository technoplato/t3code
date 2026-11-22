import {
  isDefaultLimitAccountsView,
  LIMIT_ACCOUNT_SORTS,
  LimitAccountSort,
  type LimitAccountsView,
} from "@t3tools/client-runtime/state/usage-limit-accounts";
import * as Schema from "effect/Schema";
import { msg, useGT, useMessages } from "gt-react";
import { ListFilterIcon } from "lucide-react";

import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

const SORT_LABEL: Record<LimitAccountSort, string> = {
  reset: msg("Soonest reset"),
  manual: msg("Manual order"),
  sessionMostLeft: msg("Session, most left"),
  sessionMostUsed: msg("Session, most used"),
  weekMostLeft: msg("Week, most left"),
  weekMostUsed: msg("Week, most used"),
  weekSoonest: msg("Week, soonest reset"),
};

const isSort = Schema.is(LimitAccountSort);

export function UsageLimitAccountsMenu({
  view,
  onChange,
}: {
  readonly view: LimitAccountsView;
  readonly onChange: (view: LimitAccountsView) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="icon-sm" variant="ghost" aria-label={gt("Sort and filter accounts")} />
        }
      >
        <ListFilterIcon
          className={isDefaultLimitAccountsView(view) ? undefined : "text-foreground"}
        />
      </MenuTrigger>
      <MenuPopup align="end" width="content">
        <MenuGroup>
          <MenuGroupLabel>{gt("Sort accounts")}</MenuGroupLabel>
          <MenuRadioGroup
            value={view.sort}
            onValueChange={(sort) => {
              if (isSort(sort)) onChange({ ...view, sort });
            }}
          >
            {LIMIT_ACCOUNT_SORTS.map((sort) => (
              <MenuRadioItem key={sort} value={sort}>
                {m(SORT_LABEL[sort])}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>{gt("Hide accounts with")}</MenuGroupLabel>
          <MenuCheckboxItem
            checked={view.hideEmptySessions}
            closeOnClick={false}
            onCheckedChange={(hideEmptySessions) => onChange({ ...view, hideEmptySessions })}
          >
            {gt("Empty sessions")}
          </MenuCheckboxItem>
          <MenuCheckboxItem
            checked={view.hideEmptyWeeks}
            closeOnClick={false}
            onCheckedChange={(hideEmptyWeeks) => onChange({ ...view, hideEmptyWeeks })}
          >
            {gt("Empty weeks")}
          </MenuCheckboxItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
