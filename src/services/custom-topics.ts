// Persists user-added ("custom") topics per NATS server in localStorage.
//
// Topics added manually from the Messages page may have no server-side activity
// yet, so they are not returned by `fetchActiveSubjects` and are not tracked by
// the in-memory subjectTracker. Without persistence they vanish on page reload
// (see issue #2). Storage is partitioned by NATS server URL so distinct servers
// keep independent topic lists.

const STORAGE_PREFIX = 'nats-ui-custom-topics';

function storageKey(server: string): string {
  return `${STORAGE_PREFIX}:${server}`;
}

export function getCustomTopics(server: string): string[] {
  if (!server) return [];
  try {
    const stored = localStorage.getItem(storageKey(server));
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed)
      ? parsed.filter((t): t is string => typeof t === 'string')
      : [];
  } catch (error) {
    console.warn('Failed to load custom topics:', error);
    return [];
  }
}

export function addCustomTopic(server: string, topic: string): void {
  const trimmed = topic.trim();
  if (!server || !trimmed) return;

  const existing = getCustomTopics(server);
  if (existing.includes(trimmed)) return;

  try {
    const updated = [...existing, trimmed].sort();
    localStorage.setItem(storageKey(server), JSON.stringify(updated));
  } catch (error) {
    console.warn('Failed to persist custom topic:', error);
  }
}

export function removeCustomTopic(server: string, topic: string): void {
  if (!server) return;
  try {
    const updated = getCustomTopics(server).filter((t) => t !== topic);
    localStorage.setItem(storageKey(server), JSON.stringify(updated));
  } catch (error) {
    console.warn('Failed to remove custom topic:', error);
  }
}
