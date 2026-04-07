import { randomUUID } from 'node:crypto';
import { getDb } from './database.js';
import type { ExpansionPack, ExpansionCard, PackWithCards } from './types.js';

// --- Packs ---

export function createPack(data: {
  creator_id: string;
  title: string;
  description?: string;
}): ExpansionPack {
  const db = getDb();
  const id = `pack_${randomUUID()}`;

  db.prepare(`
    INSERT INTO expansion_packs (id, creator_id, title, description)
    VALUES (?, ?, ?, ?)
  `).run(id, data.creator_id, data.title, data.description ?? '');

  const row = db.prepare('SELECT * FROM expansion_packs WHERE id = ?').get(id) as ExpansionPack;
  return normalizePackRow(row as any);
}

export function getPackById(id: string, viewerId?: string): PackWithCards | null {
  const db = getDb();
  const pack = db.prepare('SELECT * FROM expansion_packs WHERE id = ?').get(id) as ExpansionPack | undefined;
  if (!pack) return null;
  normalizePackRow(pack as any);

  if (viewerId) {
    const fav = db.prepare(
      'SELECT 1 FROM pack_favorites WHERE user_id = ? AND pack_id = ?'
    ).get(viewerId, id);
    (pack as any).is_favorited = !!fav;
  }

  const cards = db.prepare(
    'SELECT * FROM expansion_cards WHERE pack_id = ? ORDER BY sort_order ASC, created_at ASC'
  ).all(id) as ExpansionCard[];

  return { ...pack, cards };
}

type PackRow = ExpansionPack & {
  card_count: number;
  die_count: number;
  live_count: number;
  bye_count: number;
  usage_count?: number;
  favorite_count?: number;
  creator_name?: string | null;
};

function normalizePackRow<T extends { is_official: any; is_favorited?: any }>(row: T): T {
  row.is_official = !!row.is_official;
  if (row.is_favorited !== undefined) row.is_favorited = !!row.is_favorited;
  return row;
}

export function listPacks(filters: {
  creator_id?: string;
  visibility?: string;
  status?: string;
  is_official?: boolean;
  search?: string;
  sort?: 'newest' | 'most_used' | 'most_saved';
  viewer_id?: string;
  limit?: number;
  offset?: number;
}): { packs: PackRow[]; total: number } {
  const db = getDb();
  const { limit = 50, offset = 0, viewer_id, sort = 'newest' } = filters;

  const conditions: string[] = [];
  const params: any[] = [];

  if (filters.creator_id) { conditions.push('ep.creator_id = ?'); params.push(filters.creator_id); }
  if (filters.visibility) { conditions.push('ep.visibility = ?'); params.push(filters.visibility); }
  if (filters.status) { conditions.push('ep.status = ?'); params.push(filters.status); }
  if (filters.is_official !== undefined) { conditions.push('ep.is_official = ?'); params.push(filters.is_official ? 1 : 0); }
  if (filters.search && filters.search.trim()) {
    const term = `%${filters.search.trim()}%`;
    conditions.push('(ep.title LIKE ? OR ep.description LIKE ? OR u.display_name LIKE ?)');
    params.push(term, term, term);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const total = (db.prepare(
    `SELECT COUNT(*) as count FROM expansion_packs ep LEFT JOIN users u ON u.id = ep.creator_id ${where}`
  ).get(...params) as { count: number }).count;

  const favSelect = viewer_id
    ? ', CASE WHEN pf.user_id IS NULL THEN 0 ELSE 1 END as is_favorited'
    : '';
  const favJoin = viewer_id
    ? 'LEFT JOIN pack_favorites pf ON pf.pack_id = ep.id AND pf.user_id = ?'
    : '';
  const favParams = viewer_id ? [viewer_id] : [];

  let orderBy = 'ep.created_at DESC';
  if (sort === 'most_used') orderBy = 'usage_count DESC, ep.created_at DESC';
  if (sort === 'most_saved') orderBy = 'favorite_count DESC, ep.created_at DESC';

  const packs = db.prepare(`
    SELECT ep.*,
      u.display_name as creator_name,
      (SELECT COUNT(*) FROM expansion_cards ec WHERE ec.pack_id = ep.id) as card_count,
      (SELECT COUNT(*) FROM expansion_cards ec WHERE ec.pack_id = ep.id AND ec.deck_type = 'die')  as die_count,
      (SELECT COUNT(*) FROM expansion_cards ec WHERE ec.pack_id = ep.id AND ec.deck_type = 'live') as live_count,
      (SELECT COUNT(*) FROM expansion_cards ec WHERE ec.pack_id = ep.id AND ec.deck_type = 'bye')  as bye_count,
      (SELECT COUNT(*) FROM pack_usage pu WHERE pu.pack_id = ep.id) as usage_count,
      (SELECT COUNT(*) FROM pack_favorites pf2 WHERE pf2.pack_id = ep.id) as favorite_count
      ${favSelect}
    FROM expansion_packs ep
    LEFT JOIN users u ON u.id = ep.creator_id
    ${favJoin}
    ${where}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...favParams, ...params, limit, offset) as PackRow[];

  return { packs: packs.map(normalizePackRow), total };
}

export function getPackStats(packId: string): {
  card_count: number;
  die_count: number;
  live_count: number;
  bye_count: number;
  usage_count: number;
  favorite_count: number;
} | null {
  const db = getDb();
  const pack = db.prepare('SELECT id FROM expansion_packs WHERE id = ?').get(packId);
  if (!pack) return null;

  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM expansion_cards WHERE pack_id = ?) as card_count,
      (SELECT COUNT(*) FROM expansion_cards WHERE pack_id = ? AND deck_type = 'die')  as die_count,
      (SELECT COUNT(*) FROM expansion_cards WHERE pack_id = ? AND deck_type = 'live') as live_count,
      (SELECT COUNT(*) FROM expansion_cards WHERE pack_id = ? AND deck_type = 'bye')  as bye_count,
      (SELECT COUNT(*) FROM pack_usage     WHERE pack_id = ?) as usage_count,
      (SELECT COUNT(*) FROM pack_favorites WHERE pack_id = ?) as favorite_count
  `).get(packId, packId, packId, packId, packId, packId) as any;
}

export function recordPackUsage(packId: string, gameId: string): void {
  const db = getDb();
  db.prepare(
    'INSERT INTO pack_usage (pack_id, game_id) VALUES (?, ?)'
  ).run(packId, gameId);
}

export function listUserFavorites(viewerId: string): PackRow[] {
  const db = getDb();
  const packs = db.prepare(`
    SELECT ep.*,
      u.display_name as creator_name,
      (SELECT COUNT(*) FROM expansion_cards ec WHERE ec.pack_id = ep.id) as card_count,
      (SELECT COUNT(*) FROM expansion_cards ec WHERE ec.pack_id = ep.id AND ec.deck_type = 'die')  as die_count,
      (SELECT COUNT(*) FROM expansion_cards ec WHERE ec.pack_id = ep.id AND ec.deck_type = 'live') as live_count,
      (SELECT COUNT(*) FROM expansion_cards ec WHERE ec.pack_id = ep.id AND ec.deck_type = 'bye')  as bye_count,
      (SELECT COUNT(*) FROM pack_usage pu WHERE pu.pack_id = ep.id) as usage_count,
      (SELECT COUNT(*) FROM pack_favorites pf2 WHERE pf2.pack_id = ep.id) as favorite_count,
      1 as is_favorited
    FROM expansion_packs ep
    INNER JOIN pack_favorites pf ON pf.pack_id = ep.id AND pf.user_id = ?
    LEFT JOIN users u ON u.id = ep.creator_id
    ORDER BY pf.created_at DESC
  `).all(viewerId) as PackRow[];
  return packs.map(normalizePackRow);
}

export function addFavorite(userId: string, packId: string): void {
  const db = getDb();
  db.prepare(
    'INSERT OR IGNORE INTO pack_favorites (user_id, pack_id) VALUES (?, ?)'
  ).run(userId, packId);
}

export function removeFavorite(userId: string, packId: string): void {
  const db = getDb();
  db.prepare(
    'DELETE FROM pack_favorites WHERE user_id = ? AND pack_id = ?'
  ).run(userId, packId);
}

export function setPackOfficial(packId: string, isOfficial: boolean): ExpansionPack | null {
  const db = getDb();
  const result = db.prepare(
    "UPDATE expansion_packs SET is_official = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(isOfficial ? 1 : 0, packId);
  if (result.changes === 0) return null;
  const row = db.prepare('SELECT * FROM expansion_packs WHERE id = ?').get(packId) as ExpansionPack;
  return normalizePackRow(row as any);
}

export function updatePack(id: string, updates: {
  title?: string;
  description?: string;
  visibility?: string;
  status?: string;
  feature_card_id?: string | null;
}): ExpansionPack | null {
  const db = getDb();

  const pack = db.prepare('SELECT * FROM expansion_packs WHERE id = ?').get(id) as ExpansionPack | undefined;
  if (!pack) return null;

  // Cannot publish or make public with 0 cards
  if (updates.visibility === 'public' || updates.status === 'published') {
    const cardCount = (db.prepare(
      'SELECT COUNT(*) as count FROM expansion_cards WHERE pack_id = ?'
    ).get(id) as { count: number }).count;
    if (cardCount === 0) {
      throw new Error('Cannot publish or make public a pack with no cards');
    }
  }

  // Validate feature_card_id belongs to this pack (or is null to clear)
  if (updates.feature_card_id !== undefined && updates.feature_card_id !== null) {
    const card = db.prepare(
      'SELECT id FROM expansion_cards WHERE id = ? AND pack_id = ?'
    ).get(updates.feature_card_id, id);
    if (!card) {
      throw new Error('feature_card_id must reference a card belonging to this pack');
    }
  }

  const sets: string[] = [];
  const params: any[] = [];

  if (updates.title !== undefined) { sets.push('title = ?'); params.push(updates.title); }
  if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description); }
  if (updates.visibility !== undefined) { sets.push('visibility = ?'); params.push(updates.visibility); }
  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
  if (updates.feature_card_id !== undefined) { sets.push('feature_card_id = ?'); params.push(updates.feature_card_id); }

  if (sets.length === 0) return normalizePackRow(pack as any);

  sets.push("updated_at = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE expansion_packs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  const row = db.prepare('SELECT * FROM expansion_packs WHERE id = ?').get(id) as ExpansionPack;
  return normalizePackRow(row as any);
}

export function deletePack(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM expansion_packs WHERE id = ?').run(id);
  return result.changes > 0;
}

// --- Cards ---

export function addCards(packId: string, cards: { deck_type: string; text: string }[]): ExpansionCard[] {
  const db = getDb();

  // Verify pack exists
  const pack = db.prepare('SELECT id FROM expansion_packs WHERE id = ?').get(packId);
  if (!pack) throw new Error('Pack not found');

  // Get current max sort_order
  const maxSort = (db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM expansion_cards WHERE pack_id = ?'
  ).get(packId) as { max_sort: number }).max_sort;

  const insert = db.prepare(`
    INSERT INTO expansion_cards (id, pack_id, deck_type, text, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);

  const createdIds: string[] = [];

  const transaction = db.transaction(() => {
    for (let i = 0; i < cards.length; i++) {
      const id = `card_${randomUUID()}`;
      insert.run(id, packId, cards[i].deck_type, cards[i].text, maxSort + 1 + i);
      createdIds.push(id);
    }
  });

  transaction();

  const placeholders = createdIds.map(() => '?').join(',');
  return db.prepare(
    `SELECT * FROM expansion_cards WHERE id IN (${placeholders}) ORDER BY sort_order ASC`
  ).all(...createdIds) as ExpansionCard[];
}

export function updateCard(packId: string, cardId: string, updates: {
  text?: string;
  deck_type?: string;
  sort_order?: number;
}): ExpansionCard | null {
  const db = getDb();

  const card = db.prepare(
    'SELECT * FROM expansion_cards WHERE id = ? AND pack_id = ?'
  ).get(cardId, packId) as ExpansionCard | undefined;
  if (!card) return null;

  const sets: string[] = [];
  const params: any[] = [];

  if (updates.text !== undefined) { sets.push('text = ?'); params.push(updates.text); }
  if (updates.deck_type !== undefined) { sets.push('deck_type = ?'); params.push(updates.deck_type); }
  if (updates.sort_order !== undefined) { sets.push('sort_order = ?'); params.push(updates.sort_order); }

  if (sets.length === 0) return card;

  sets.push("updated_at = datetime('now')");
  params.push(cardId, packId);

  db.prepare(`UPDATE expansion_cards SET ${sets.join(', ')} WHERE id = ? AND pack_id = ?`).run(...params);
  return db.prepare('SELECT * FROM expansion_cards WHERE id = ? AND pack_id = ?').get(cardId, packId) as ExpansionCard;
}

export function deleteCard(packId: string, cardId: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM expansion_cards WHERE id = ? AND pack_id = ?').run(cardId, packId);
  return result.changes > 0;
}

/**
 * Batch fetch all expansion cards belonging to any of the given pack IDs.
 * Used by GameRoom.startGame() to merge expansion cards into the base decks.
 */
export function getCardsByPackIds(packIds: string[]): ExpansionCard[] {
  // Strip the "base" sentinel — base game cards aren't in the DB
  const expansionIds = packIds.filter((id) => id && id !== 'base');
  if (expansionIds.length === 0) return [];
  const db = getDb();
  const placeholders = expansionIds.map(() => '?').join(',');
  return db.prepare(
    `SELECT * FROM expansion_cards WHERE pack_id IN (${placeholders}) ORDER BY sort_order ASC`
  ).all(...expansionIds) as ExpansionCard[];
}
