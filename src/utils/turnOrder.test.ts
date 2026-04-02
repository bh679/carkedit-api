import { MapSchema } from "@colyseus/schema";
import { Player } from "../schema/Player.js";
import { computeDodTurnOrder } from "./turnOrder.js";

function makePlayer(sessionId: string, birthMonth: number, birthDay: number): Player {
  const p = new Player();
  p.sessionId = sessionId;
  p.birthMonth = birthMonth;
  p.birthDay = birthDay;
  return p;
}

function makePlayersMap(entries: Array<[string, number, number]>): MapSchema<Player> {
  const map = new MapSchema<Player>();
  for (const [id, month, day] of entries) {
    map.set(id, makePlayer(id, month, day));
  }
  return map;
}

describe("computeDodTurnOrder", () => {
  // Day of the Dead = November 1 = day 305

  it("rotates to the player with the closest birthday to DoD", () => {
    // p1: Jan 1 (day 1)   → distance to 305: min(304, 61) = 61
    // p2: Feb 1 (day 32)  → distance to 305: min(273, 92) = 92
    // p3: Oct 15 (day 288)→ distance to 305: min(17, 348)  = 17  ← closest
    // p4: Dec 1 (day 335) → distance to 305: min(30, 335)  = 30
    const players = makePlayersMap([
      ["p1", 1, 1],
      ["p2", 2, 1],
      ["p3", 10, 15],
      ["p4", 12, 1],
    ]);

    expect(computeDodTurnOrder(players)).toEqual(["p3", "p4", "p1", "p2"]);
  });

  it("incorporates a new joiner who has the closest DoD birthday", () => {
    // p1–p4 as above, p5 joins with Nov 1 exactly (distance 0)
    const players = makePlayersMap([
      ["p1", 1, 1],
      ["p2", 2, 1],
      ["p3", 10, 15],
      ["p4", 12, 1],
      ["p5", 11, 1], // exactly DoD → distance 0
    ]);

    expect(computeDodTurnOrder(players)).toEqual(["p5", "p1", "p2", "p3", "p4"]);
  });

  it("places players with unknown birthdays (0/0) last", () => {
    // p1: Oct 15 → distance 17  ← closest
    // p2: unknown (0,0) → Infinity
    const players = makePlayersMap([
      ["p1", 10, 15],
      ["p2", 0, 0],
    ]);

    expect(computeDodTurnOrder(players)).toEqual(["p1", "p2"]);
  });

  it("first joiner wins on a tie (stable sort)", () => {
    // p1 and p2 both Nov 1 → distance 0
    const players = makePlayersMap([
      ["p1", 11, 1],
      ["p2", 11, 1],
    ]);

    // p1 joined first → stays at index 0
    expect(computeDodTurnOrder(players)).toEqual(["p1", "p2"]);
  });

  it("preserves join order when all birthdays are unknown", () => {
    const players = makePlayersMap([
      ["p1", 0, 0],
      ["p2", 0, 0],
      ["p3", 0, 0],
    ]);

    // All Infinity → closestIndex stays 0, order unchanged
    expect(computeDodTurnOrder(players)).toEqual(["p1", "p2", "p3"]);
  });
});
