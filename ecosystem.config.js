// PM2 process config — keeps the MoneyMatch API alive and restarts it on crash.
//
//   pm2 start ecosystem.config.js     # start under supervision (run from this dir)
//   pm2 save                          # persist the process list across pm2 restarts
//   pm2 logs moneymatch               # tail logs
//   pm2 restart moneymatch            # manual restart after a deploy
//
// Reboot persistence on Windows uses pm2-windows-startup (see setup notes), since
// `pm2 startup` doesn't support Windows natively.
//
// IMPORTANT: single instance, fork mode — do NOT cluster. The app relies on an
// in-process write mutex (txn.js), a single SQLite writer, and an in-process
// wallet/bankroll cache. A second instance would each get its own mutex/cache and
// reintroduce the debit-without-settle money race plus SQLite write contention.
module.exports = {
  apps: [
    {
      name: 'moneymatch',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 50,
      min_uptime: '10s',      // crashes within 10s count toward the limit (no hot-loop)
      restart_delay: 2000,
      watch: false,
      max_memory_restart: '500M',
      env: { NODE_ENV: 'production' },
      // App config (DATABASE_PATH, JWT_SECRET, PORT, ENABLE_DEMO) is loaded from
      // .env via dotenv at startup, so it isn't duplicated here.
    },
  ],
};
