
import { count } from "./format";
import type { Turbine } from "./types";

export interface LayerShare {
  key: "root" | "layer-1" | "layer-2" | "layer-3";
  label: string;
  share: number;
}

export function layerShares(turbine: Turbine): LayerShare[] | null {
  const total = turbine.root + turbine.layer_1 + turbine.layer_2 + turbine.layer_3;
  if (total <= 0) return null;
  return [
    { key: "root", label: "root", share: turbine.root / total },
    { key: "layer-1", label: "1st layer", share: turbine.layer_1 / total },
    { key: "layer-2", label: "2nd layer", share: turbine.layer_2 / total },
    { key: "layer-3", label: "3rd layer", share: turbine.layer_3 / total },
  ];
}

/** Nought is the healthy reading. */
export function dropsLabel(dropped: number): string {
  return dropped > 0 ? `${count(dropped)} shreds dropped, channel full` : "no shreds dropped";
}
