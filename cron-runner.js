// ============================================================
// CRON RUNNER — Palaiž cleanup robotu ik pēc 5 minūtēm
// Izmanto tiešo importu — bez HTTP, bez portiem, bez localhost
// ============================================================
import { executePendingCleanup } from "./functions/api/cleanup-pending.js";

let interval = null;

export function startCleanupCron() {
  if (interval) return;
  console.log('⏰ Cleanup cron started (every 5 min)');

  interval = setInterval(async () => {
    try {
      // Pa tiešo — bez fetch, bez HTTP, bez tīkla
      const result = await executePendingCleanup(process.env);
      if (result.cancelled > 0) console.log(`🧹 Cleanup: ${result.cancelled} expired mints refunded`);
    } catch (e) {
      console.error('🧹 Cleanup cron error:', e.message);
    }
  }, 5 * 60 * 1000);
}

export function stopCleanupCron() {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
