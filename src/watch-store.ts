/**
 * Persistence for watch registrations.
 *
 * Default path: ~/.config/ynab-mcp/watches.json
 * Override with env var YNAB_WATCH_STORE.
 *
 * Each watch persists its registration params + the last observed
 * threshold-state snapshot so we only fire on threshold CROSSES
 * across MCP server restarts.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

export interface WatchThresholds {
  category_overspend_pct?: number;
  category_underspend_pct?: number;
  total_available_below?: number;
}

/**
 * Per-trigger boolean flags: did the previous poll consider the condition met?
 * category_* maps are keyed by category_id.
 */
export interface WatchSnapshot {
  category_overspend: Record<string, boolean>;
  category_underspend: Record<string, boolean>;
  total_available_below: boolean;
  lastPolledAt: string | null; // ISO timestamp
}

export interface Watch {
  id: string;
  webhookUrl: string;
  budgetId: string;
  thresholds: WatchThresholds;
  createdAt: string; // ISO
  snapshot: WatchSnapshot;
}

export interface WatchStoreFile {
  version: 1;
  watches: Watch[];
}

function defaultStorePath(): string {
  return path.join(os.homedir(), '.config', 'ynab-mcp', 'watches.json');
}

export function resolveStorePath(): string {
  const override = process.env['YNAB_WATCH_STORE'];
  return override && override.length > 0 ? override : defaultStorePath();
}

export function emptySnapshot(): WatchSnapshot {
  return {
    category_overspend: {},
    category_underspend: {},
    total_available_below: false,
    lastPolledAt: null,
  };
}

export function loadWatches(storePath: string = resolveStorePath()): Watch[] {
  if (!fs.existsSync(storePath)) return [];
  try {
    const raw = fs.readFileSync(storePath, 'utf-8');
    const parsed = JSON.parse(raw) as WatchStoreFile;
    if (!parsed || !Array.isArray(parsed.watches)) return [];
    return parsed.watches.map((w) => ({
      ...w,
      snapshot: w.snapshot ?? emptySnapshot(),
    }));
  } catch {
    return [];
  }
}

export function saveWatches(watches: Watch[], storePath: string = resolveStorePath()): void {
  const dir = path.dirname(storePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  }
  const file: WatchStoreFile = { version: 1, watches };
  fs.writeFileSync(storePath, JSON.stringify(file, null, 2), { mode: 0o600 });
}
