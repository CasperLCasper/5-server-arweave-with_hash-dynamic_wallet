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
      // Izmanto 127.0.0.1 Docker videi (nevis localhost)
      const res = await fetch(`http://127.0.0.1:${port}/api/cleanup-pending`);
      const data = await res.json();
      if (data.cancelled > 0) console.log(`🧹 Cleanup: ${data.cancelled} expired mints refunded`);
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
