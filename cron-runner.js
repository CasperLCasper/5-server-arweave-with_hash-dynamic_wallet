// ============================================================
// CRON RUNNER — Palaiž cleanup robotu ik pēc 5 minūtēm
// ============================================================
let interval = null;

export function startCleanupCron() {
  if (interval) return;
  console.log('⏰ Cleanup cron started (every 5 min)');
  interval = setInterval(async () => {
    try {
      const port = process.env.PORT || 3000;
      const res = await fetch(`http://localhost:${port}/api/cleanup-pending`);
      const data = await res.json();
      if (data.cancelled > 0) console.log(`🧹 Cleanup: ${data.cancelled} expired mints refunded`);
    } catch (e) {
      // Klusām — negribam pārpludināt logus
    }
  }, 5 * 60 * 1000);
}

export function stopCleanupCron() {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
