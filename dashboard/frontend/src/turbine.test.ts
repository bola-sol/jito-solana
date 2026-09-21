import { describe, expect, it } from "vitest";
import { dropsLabel, layerShares } from "./turbine";
import type { Turbine } from "./types";

function turbine(over: Partial<Turbine> = {}): Turbine {
  return {
    window_seconds: 300,
    root: 30,
    layer_1: 410,
    layer_2: 550,
    layer_3: 10,
    xdp_dropped: 0,
    xdp_dropped_total: 0,
    xdp: true,
    ...over,
  };
}

describe("layerShares", () => {
  it("shares the received shreds across the four layers", () => {
    const shares = layerShares(turbine());
    expect(shares?.map((layer) => layer.share)).toEqual([0.03, 0.41, 0.55, 0.01]);
    expect(shares?.map((layer) => layer.key)).toEqual(["root", "layer-1", "layer-2", "layer-3"]);
  });

  it("is nothing where no shreds arrived", () => {
    expect(layerShares(turbine({ root: 0, layer_1: 0, layer_2: 0, layer_3: 0 }))).toBeNull();
  });
});

describe("dropsLabel", () => {
  it("names nought as the healthy reading", () => {
    expect(dropsLabel(0)).toBe("no shreds dropped");
  });

  it("names the channel filling", () => {
    expect(dropsLabel(35_500_338)).toBe("35,500,338 shreds dropped, channel full");
  });
});
