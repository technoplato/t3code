import { useCallback, useState } from "react";
import * as Haptics from "expo-haptics";

import { toggleSelectedThreadKey } from "./threadMultiSelect";

const EMPTY_SELECTED_KEYS: ReadonlySet<string> = new Set();

export interface ThreadMultiSelectController {
  readonly selectionMode: boolean;
  readonly selectedKeys: ReadonlySet<string>;
  readonly enterSelectionMode: (initialThreadKey?: string) => void;
  readonly toggleThreadKey: (threadKey: string) => void;
  readonly selectThreadKeys: (threadKeys: ReadonlyArray<string>) => void;
  readonly exitSelectionMode: () => void;
}

export function useThreadMultiSelect(): ThreadMultiSelectController {
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(EMPTY_SELECTED_KEYS);

  const enterSelectionMode = useCallback((initialThreadKey?: string) => {
    void Haptics.selectionAsync();
    setSelectionMode(true);
    if (initialThreadKey !== undefined) {
      setSelectedKeys((current) => {
        const next = new Set(current);
        next.add(initialThreadKey);
        return next;
      });
    }
  }, []);

  const toggleThreadKey = useCallback((threadKey: string) => {
    void Haptics.selectionAsync();
    setSelectedKeys((current) => toggleSelectedThreadKey(current, threadKey));
  }, []);

  const selectThreadKeys = useCallback((threadKeys: ReadonlyArray<string>) => {
    void Haptics.selectionAsync();
    setSelectionMode(true);
    setSelectedKeys(new Set(threadKeys));
  }, []);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedKeys(EMPTY_SELECTED_KEYS);
  }, []);

  return {
    selectionMode,
    selectedKeys,
    enterSelectionMode,
    toggleThreadKey,
    selectThreadKeys,
    exitSelectionMode,
  };
}
