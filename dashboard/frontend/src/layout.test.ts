import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BALANCES_STORAGE_KEY,
  CERTIFICATES_STORAGE_KEY,
  OPENED_STORAGE_KEY,
  readBalancesHidden,
  readCertificatesOpen,
  readFoldOpen,
  readInterfacesOpen,
  readScheduleColumns,
  readSlotStripFolded,
  SCHEDULE_COLUMNS_STORAGE_KEY,
  SLOT_STRIP_STORAGE_KEY,
  writeBalancesHidden,
  writeCertificatesOpen,
  writeFoldOpen,
  writeInterfacesOpen,
  writeScheduleColumns,
  writeSlotStripFolded,
} from "./layout";

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

beforeEach(() => {
  vi.stubGlobal("window", { localStorage: storage() });
});

describe("hidden balances", () => {
  it("starts shown when nothing has been chosen", () => {
    expect(readBalancesHidden()).toBe(false);
  });

  it("remembers the choice both ways", () => {
    writeBalancesHidden(true);
    expect(readBalancesHidden()).toBe(true);
    writeBalancesHidden(false);
    expect(readBalancesHidden()).toBe(false);
  });

  it("treats an unrecognised value as shown", () => {
    window.localStorage.setItem(BALANCES_STORAGE_KEY, "yes");
    expect(readBalancesHidden()).toBe(false);
  });

  it("survives storage being refused", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("denied");
      },
    });
    expect(() => writeBalancesHidden(true)).not.toThrow();
    expect(readBalancesHidden()).toBe(false);
  });
});

describe("the certificates list", () => {
  it("starts closed when nothing has been chosen", () => {
    expect(readCertificatesOpen()).toBe(false);
  });

  it("remembers the choice both ways", () => {
    writeCertificatesOpen(true);
    expect(readCertificatesOpen()).toBe(true);
    writeCertificatesOpen(false);
    expect(readCertificatesOpen()).toBe(false);
  });

  it("treats an unrecognised value as closed", () => {
    window.localStorage.setItem(CERTIFICATES_STORAGE_KEY, "yes");
    expect(readCertificatesOpen()).toBe(false);
  });

  it("survives storage being refused", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("denied");
      },
    });
    expect(() => writeCertificatesOpen(true)).not.toThrow();
    expect(readCertificatesOpen()).toBe(false);
  });
});

describe("the schedule's column group", () => {
  it("starts on status when nothing has been chosen", () => {
    expect(readScheduleColumns()).toBe("status");
  });

  it("remembers each group", () => {
    for (const group of ["fees", "timing", "load", "status"] as const) {
      writeScheduleColumns(group);
      expect(readScheduleColumns()).toBe(group);
    }
  });

  it("treats an unrecognised value as status", () => {
    window.localStorage.setItem(SCHEDULE_COLUMNS_STORAGE_KEY, "everything");
    expect(readScheduleColumns()).toBe("status");
  });

  it("survives storage being refused", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("denied");
      },
    });
    expect(() => writeScheduleColumns("fees")).not.toThrow();
    expect(readScheduleColumns()).toBe("status");
  });
});

describe("the network card's interface list", () => {
  it("starts folded when nothing has been chosen", () => {
    expect(readInterfacesOpen()).toBe(false);
  });

  it("remembers the choice both ways", () => {
    writeInterfacesOpen(true);
    expect(readInterfacesOpen()).toBe(true);
    writeInterfacesOpen(false);
    expect(readInterfacesOpen()).toBe(false);
  });

  it("survives storage being refused", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("denied");
      },
    });
    expect(() => writeInterfacesOpen(true)).not.toThrow();
    expect(readInterfacesOpen()).toBe(false);
  });
});

describe("folds", () => {
  it("start folded when nothing has been chosen", () => {
    expect(readFoldOpen("machine")).toBe(false);
  });

  it("remember an opened fold, and forget it once folded again", () => {
    writeFoldOpen("replay", true);
    writeFoldOpen("machine", true);
    expect(readFoldOpen("replay")).toBe(true);
    expect(window.localStorage.getItem(OPENED_STORAGE_KEY)).toBe("replay,machine");
    writeFoldOpen("replay", false);
    expect(readFoldOpen("replay")).toBe(false);
    expect(readFoldOpen("machine")).toBe(true);
  });

  it("ignore the old folded list", () => {
    window.localStorage.setItem("agave-dashboard-folded", "machine");
    expect(readFoldOpen("machine")).toBe(false);
  });

  it("survive storage being refused", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("denied");
      },
    });
    expect(() => writeFoldOpen("tpu", true)).not.toThrow();
    expect(readFoldOpen("tpu")).toBe(false);
  });
});

describe("slot strip fold", () => {
  it("starts open when nothing has been chosen", () => {
    expect(readSlotStripFolded()).toBe(false);
  });

  it("remembers the choice both ways", () => {
    writeSlotStripFolded(true);
    expect(readSlotStripFolded()).toBe(true);
    writeSlotStripFolded(false);
    expect(readSlotStripFolded()).toBe(false);
  });

  it("treats an unrecognised value as open", () => {
    window.localStorage.setItem(SLOT_STRIP_STORAGE_KEY, "yes");
    expect(readSlotStripFolded()).toBe(false);
  });
});
