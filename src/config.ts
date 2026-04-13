import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Config, CategoryCache } from './types';

const CONFIG_DIR = path.join(os.homedir(), '.ynab-cli');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function categoriesFilePath(budgetId: string): string {
  return path.join(CONFIG_DIR, `categories-${budgetId}.json`);
}

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { mode: 0o700, recursive: true });
  }
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_FILE);
}

export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(
      'No configuration found. Run ynab_sync_categories or set up ~/.ynab-cli/config.json.'
    );
  }
  const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
  return JSON.parse(raw) as Config;
}

export function saveConfig(config: Config): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function loadCategoryCache(budgetId: string): CategoryCache | null {
  const file = categoriesFilePath(budgetId);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    return JSON.parse(raw) as CategoryCache;
  } catch {
    return null;
  }
}

export function saveCategoryCache(budgetId: string, cache: CategoryCache): void {
  ensureConfigDir();
  fs.writeFileSync(categoriesFilePath(budgetId), JSON.stringify(cache, null, 2), { mode: 0o600 });
}

export const CONFIG_DIR_PATH = CONFIG_DIR;
