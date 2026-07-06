// PM2 process file — `pm2 start ecosystem.config.cjs`
// Keeps the backend running continuously on a VPS, restarts on crash,
// and rotates nothing itself (the app writes its own capped logs to data/).
module.exports = {
  apps: [
    {
      name: 'kyngpyn',
      script: 'src/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        TRADING_MODE: 'simulation',
        PORT: 8420,
      },
      env_paper: {
        NODE_ENV: 'production',
        TRADING_MODE: 'paper',
        PORT: 8420,
      },
    },
  ],
};
