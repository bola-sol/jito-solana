import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BALANCES_STORAGE_KEY,
  CERTIFICATES_STORAGE_KEY,
  readBalancesHidden,
  readCertificatesOpen,
  readInterfacesOpen,
  readScheduleColumns,
  readSidebarCollapsed,
  SCHEDULE_COLUMNS_STORAGE_KEY,
  SIDEBAR_STORAGE_KEY,
  writeBalancesHidden,
  writeCertificatesOpen,
  writeInterfacesOpen,
  writeScheduleColumns,
  writeSidebarCollapsed,
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

describe("sidebar collapse", () => {
  it("starts expanded when nothing has been chosen", () => {
    expect(readSidebarCollapsed()).toBe(false);
  });

  it("remembers the choice both ways", () => {
    writeSidebarCollapsed(true);
    expect(readSidebarCollapsed()).toBe(true);
    writeSidebarCollapsed(false);
    expect(readSidebarCollapsed()).toBe(false);
  });

  it("treats an unrecognised value as expanded", () => {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, "yes");
    expect(readSidebarCollapsed()).toBe(false);
  });

  it("survives storage being refused", () => {
    // Private browsing and some embedded webviews throw on access rather than
    // returning null, which would otherwise take the whole app down at render.
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("denied");
      },
    });
    expect(() => writeSidebarCollapsed(true)).not.toThrow();
    expect(readSidebarCollapsed()).toBe(false);
  });
});
