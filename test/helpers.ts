import { initDb } from '../src/db.js';
import { initSettings } from '../src/settings.js';

/** DB in-memory + settings default yang segar untuk tiap test. */
export function freshDb(): void {
  initDb(':memory:');
  initSettings('');
}
