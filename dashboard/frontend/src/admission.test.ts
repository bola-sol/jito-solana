import { describe, expect, it } from "vitest";
import { noSeatDetail, noSeatLabel } from "./admission";

describe("noSeatLabel", () => {
  it("says what it knows about the next epoch", () => {
    expect(noSeatLabel({ seat: false, next_seat: true, ticket_short: null })).toBe(
      "this epoch, the next is covered",
    );
    expect(noSeatLabel({ seat: false, next_seat: false, ticket_short: null })).toBe(
      "this epoch, nor the next",
    );
    expect(noSeatLabel({ seat: false, next_seat: null, ticket_short: null })).toBe("this epoch");
  });
});

describe("noSeatDetail", () => {
  it("names the shortfall when the ticket is not covered", () => {
    expect(noSeatDetail({ seat: false, next_seat: false, ticket_short: 590_000_000 })).toBe(
      "0.59 SOL short of the next epoch's ticket",
    );
  });

  it("says a seat is coming, or not, when the ticket is covered", () => {
    expect(noSeatDetail({ seat: false, next_seat: true, ticket_short: null })).toBe("a seat next epoch");
    expect(noSeatDetail({ seat: false, next_seat: false, ticket_short: null })).toBe("no seat next epoch");
  });

  it("says nothing before the next epoch is known", () => {
    expect(noSeatDetail({ seat: false, next_seat: null, ticket_short: null })).toBeUndefined();
  });
});
