import { MapSchema } from "@colyseus/schema";
import { Player } from "../schema/Player";

// Day of the Dead: November 1
const DOD_MONTH = 11;
const DOD_DAY = 1;

function dayOfYear(month: number, day: number): number {
  const daysInMonth = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let d = 0;
  for (let m = 1; m < month; m++) d += daysInMonth[m];
  return d + day;
}

const DOD_DAY_OF_YEAR = dayOfYear(DOD_MONTH, DOD_DAY); // 305

function dodDistance(month: number, day: number): number {
  if (!month || !day) return Infinity;
  const bday = dayOfYear(month, day);
  const diff = Math.abs(bday - DOD_DAY_OF_YEAR);
  return Math.min(diff, 365 - diff);
}

// Returns player session IDs in join order, rotated to start at DOD-closest birthday.
// Players with unknown birthdays (month=0 or day=0) are treated as farthest from DOD.
export function computeDodTurnOrder(players: MapSchema<Player>): string[] {
  const entries = Array.from(players.entries());

  let closestIndex = 0;
  let closestDistance = Infinity;

  entries.forEach(([, player], index) => {
    const dist = dodDistance(player.birthMonth, player.birthDay);
    if (dist < closestDistance) {
      closestDistance = dist;
      closestIndex = index;
    }
  });

  const ids = entries.map(([id]) => id);
  return [...ids.slice(closestIndex), ...ids.slice(0, closestIndex)];
}
