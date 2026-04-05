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

  return db.prepare('SELECT * FROM expansion_packs WHERE id = ?').get(id) as ExpansionPack;
}

export function getPackById(id: string): PackWithCards | null {
  const db = getDb();
  const pack = db.prepare('SELECT * FROM expansion_packs WHERE id = ?').get(id) as ExpansionPack | undefined;
  if (!pack) return null;

  const cards = db.prepare(
    'SELECT * FROM expansion_cards WHERE pack_id = ? ORDER BY sort_order ASC, created_at ASC'
  ).all(id) as ExpansionCard[];

  return { ...pack, cards };
}

export function listPacks(filters: {
  creator_id?: string;
  visibility?: string;
  status?: string;
  limit?: number;
  offset?: number;
}): { packs: (ExpansionPack & { card_count: number })[]; total: number } {
  const db = getDb();
  const { limit = 50, offset = 0 } = filters;

  const conditions: string[] = [];
  const params: any[] = [];

  if (filters.creator_id) { conditions.push('ep.creator_id = ?'); params.push(filters.creator_id); }
  if (filters.visibility) { conditions.push('ep.visibility = ?'); params.push(filters.visibility); }
  if (filters.status) { conditions.push('ep.status = ?'); params.push(filters.status); }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const total = (db.prepare(
    `SELECT COUNT(*) as count FROM expansion_packs ep ${where}`
  ).get(...params) as { count: number }).count;

  const packs = db.prepare(`
    SELECT ep.*, COUNT(ec.id) as card_count
    FROM expansion_packs ep
    LEFT JOIN expansion_cards ec ON ec.pack_id = ep.id
    ${where}
    GROUP BY ep.id
    ORDER BY ep.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as (ExpansionPack & { card_count: number })[];

  return { packs, total };
}

export function updatePack(id: string, updates: {
  title?: string;
  description?: string;
  visibility?: string;
  status?: string;
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

  const sets: string[] = [];
  const params: any[] = [];

  if (updates.title !== undefined) { sets.push('title = ?'); params.push(updates.title); }
  if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description); }
  if (updates.visibility !== undefined) { sets.push('visibility = ?'); params.push(updates.visibility); }
  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }

  if (sets.length === 0) return pack;

  sets.push("updated_at = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE expansion_packs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return db.prepare('SELECT * FROM expansion_packs WHERE id = ?').get(id) as ExpansionPack;
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
