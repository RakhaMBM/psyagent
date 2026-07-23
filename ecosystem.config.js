module.exports = {
  apps: [
    {
      name: 'psyagent',
      script: 'server.js',
      cwd: '/etc/www/psyagent',
      // Кластерный режим: PM2 поднимает по одному воркеру на ядро CPU
      // и балансирует входящие соединения между ними (общий порт).
      exec_mode: 'cluster',
      instances: 'max',
      // Приложение stateless (JWT + MySQL), общего in-memory состояния нет,
      // поэтому воркеры безопасно масштабируются горизонтально.
      max_memory_restart: '400M',
      // Env берётся из .env через dotenv в самом server.js; здесь ничего
      // не переопределяем, чтобы не менять текущее поведение (NODE_ENV не задан).
      kill_timeout: 5000,
      wait_ready: false,
    },
  ],
};
